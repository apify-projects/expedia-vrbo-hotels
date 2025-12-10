"""
GraphQL client for Expedia and Hotels.com property details API.

Uses the same GraphQL queries as VRBO (same Expedia Group backend).
TLS impersonation via tls_client (OkHttp/Android fingerprint).
"""

import asyncio
import re
import uuid
from urllib.parse import urlparse
from datetime import datetime, timedelta, timezone
from typing import Optional, Callable
from functools import wraps

import tls_client

from auth import get_signed_headers
from queries.vrbo_queries import (
    PROPERTY_CONTENT_QUERY,
    PROPERTY_SUMMARY_QUERY,
    PRODUCT_GALLERY_QUERY,
    PROPERTY_OFFERS_QUERY,
    PRODUCT_REVIEW_SUMMARY_HASH,
    TEMPLATE_PAGE_LAYOUT_QUERY,
)


def async_retry_on_error(max_retries: int = 3, delay: float = 2.0, backoff: float = 2.0):
    """
    Decorator to retry an async function on exception.
    """
    def decorator(func: Callable[..., asyncio.Future]):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            last_exception = None
            current_delay = delay

            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if attempt < max_retries:
                        await asyncio.sleep(current_delay)
                        current_delay *= backoff

            raise last_exception
        return wrapper
    return decorator


# Site configurations for Expedia and Hotels.com
SITE_CONFIGS = {
    # Expedia sites
    "expedia.com": {
        "base_url": "https://www.expedia.com",
        "site_id": 1,
        "tpid": 1,
        "eapid": 0,
        "locale": "en_US",
        "currency": "USD",
        "app_name": "android.com.expedia.bookings",
        "app_version": "2024.47.0",
    },
    "expedia.co.uk": {
        "base_url": "https://www.expedia.co.uk",
        "site_id": 70201,
        "tpid": 70201,
        "eapid": 0,
        "locale": "en_GB",
        "currency": "GBP",
        "app_name": "android.com.expedia.bookings",
        "app_version": "2024.47.0",
    },
    # Hotels.com sites
    "hotels.com": {
        "base_url": "https://www.hotels.com",
        "site_id": 300000001,
        "tpid": 3001,
        "eapid": 0,
        "locale": "en_US",
        "currency": "USD",
        "app_name": "android.com.hcom.android",
        "app_version": "2024.47.0",
    },
    "hotels.co.uk": {
        "base_url": "https://uk.hotels.com",
        "site_id": 300000026,
        "tpid": 3001,
        "eapid": 26,
        "locale": "en_GB",
        "currency": "GBP",
        "app_name": "android.com.hcom.android",
        "app_version": "2024.47.0",
    },
}


def detect_site_from_url(url: str) -> Optional[str]:
    """Detect site key from URL domain."""
    if not url.startswith("http"):
        return None
    parsed = urlparse(url)
    host = parsed.netloc.lower().replace("www.", "").replace("uk.", "")

    # Check for exact matches first
    for site_key in SITE_CONFIGS:
        if site_key in host:
            return site_key
    return None


def extract_property_id_from_url(url: str) -> tuple[Optional[str], Optional[str]]:
    """
    Extract property ID from Expedia/Hotels.com URL formats.

    Supported formats:
    - https://www.expedia.com/Hotel-Search?selected=12345678
    - https://www.expedia.com/h12345678.Hotel-Information
    - https://www.hotels.com/ho12345678/
    - https://www.hotels.com/hotel/property-name/h12345678/

    Returns:
        Tuple of (property_id, platform) where platform is 'expedia' or 'hotels'
    """
    url = url.strip().rstrip('"\'')

    if not url.startswith("http"):
        return None, None

    parsed = urlparse(url)
    path = parsed.path.strip("/")
    host = parsed.netloc.lower()

    # Determine platform
    platform = None
    if "expedia" in host:
        platform = "expedia"
    elif "hotels.com" in host:
        platform = "hotels"

    # Pattern 1: /h{ID} or /ho{ID} in path
    match = re.search(r'/h[o]?(\d+)', "/" + path, re.IGNORECASE)
    if match:
        return match.group(1), platform

    # Pattern 2: selected=ID in query string
    if "selected=" in url:
        match = re.search(r'selected=(\d+)', url)
        if match:
            return match.group(1), platform

    # Pattern 3: destination=ID in query string
    if "destination=" in url:
        match = re.search(r'destination=(\d+)', url)
        if match:
            return match.group(1), platform

    return None, platform


def parse_date(date_str: str) -> dict:
    """Parse YYYY-MM-DD date string to API format."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return {
        "day": dt.day,
        "month": dt.month,
        "year": dt.year
    }


def get_default_dates() -> tuple[str, str]:
    """Get default check-in (tomorrow) and check-out (2 nights later) dates."""
    tomorrow = datetime.now(timezone.utc) + timedelta(days=1)
    checkout = tomorrow + timedelta(days=2)
    return tomorrow.strftime("%Y-%m-%d"), checkout.strftime("%Y-%m-%d")


class ExpediaPropertyClient:
    """Client for fetching property details from Expedia/Hotels.com GraphQL API."""

    def __init__(
        self,
        site: str = "expedia.com",
        currency: Optional[str] = None,
        proxy_url: Optional[str] = None,
        timeout: float = 30.0
    ):
        """
        Initialize client for Expedia or Hotels.com.

        Args:
            site: Site key from SITE_CONFIGS (e.g., 'expedia.com', 'hotels.com')
            currency: Override currency (optional)
            proxy_url: Proxy URL (e.g., 'http://user:pass@proxy:8080')
        """
        if site not in SITE_CONFIGS:
            raise ValueError(f"Unknown site: {site}. Available: {list(SITE_CONFIGS.keys())}")

        self.site_config = SITE_CONFIGS[site].copy()
        if currency:
            self.site_config["currency"] = currency

        self.base_url = self.site_config["base_url"]
        self.graphql_endpoint = f"{self.base_url}/graphql"
        self.device_id = str(uuid.uuid4())
        self.proxy_url = proxy_url
        self.timeout = timeout

        # Create TLS client with OkHttp/Android fingerprint
        self.session = tls_client.Session(
            client_identifier="okhttp4_android_13",
            random_tls_extension_order=True
        )

        # Minimal cookie state
        self.session.cookies.update({
            "ha-device-id": self.device_id,
            "DUAID": self.device_id
        })

        # Set proxy if provided
        if proxy_url:
            self.session.proxies = {
                "http": proxy_url,
                "https": proxy_url
            }

    async def _post_json(self, payload: dict, headers: dict, raise_on_graphql_errors: bool = True) -> dict:
        """Execute a POST request in a worker thread with an overall timeout.

        Args:
            payload: GraphQL request payload
            headers: HTTP headers
            raise_on_graphql_errors: If True, raise exception when GraphQL returns errors
        """
        response = await asyncio.wait_for(
            asyncio.to_thread(
                self.session.post,
                self.graphql_endpoint,
                json=payload,
                headers=headers
            ),
            timeout=self.timeout
        )

        if response.status_code >= 400:
            raise Exception(f"HTTP {response.status_code}: {response.text[:500]}")

        data = response.json()

        # Check for GraphQL errors
        if raise_on_graphql_errors and "errors" in data:
            errors = data["errors"]
            if errors:
                error_messages = [e.get("message", str(e)) for e in errors]
                raise Exception(f"GraphQL errors: {'; '.join(error_messages)}")

        return data

    def _get_headers(self, operation_name: str, operation_id: str) -> dict:
        """Get all required headers for the request."""
        parsed = urlparse(self.graphql_endpoint)
        path = parsed.path

        # Get HMAC signed headers
        signed_headers = get_signed_headers("POST", path, None)

        locale = self.site_config["locale"]
        app_name = self.site_config["app_name"]
        app_version = self.site_config["app_version"]

        headers = {
            "accept": "multipart/mixed;deferSpec=20220824, application/graphql-response+json, application/json",
            "content-type": "application/json",
            "user-agent": f"Expedia/{app_version} Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)",
            "client-info": f"{app_name},{app_version},external",
            "device-user-agent-id": self.device_id,
            "x-eb-client": f"PLATFORM:ANDROID;OS_VERSION:13;MANUFACTURER:unknown;MODEL:Generic Android-x86_64;MODEL_NAME:Generic Android-x86_64;UPGRADE:false;APP_VERSION:{app_version};LOCALE:{locale};APP_IDENTIFIER:{app_name.replace('android.', '')};",
            "x-apollo-operation-name": operation_name,
            "x-apollo-operation-id": operation_id,
            "x-mobvisid": str(uuid.uuid4()),
            "ctx-view-id": str(uuid.uuid4()),
            **signed_headers
        }

        return headers

    def _build_context(self) -> dict:
        """Build the context object for GraphQL queries."""
        return {
            "clientInfo": {
                "name": self.site_config["app_name"],
                "version": self.site_config["app_version"]
            },
            "currency": self.site_config["currency"],
            "locale": self.site_config["locale"],
            "siteId": self.site_config["site_id"],
            "tpid": self.site_config["tpid"],
            "eapid": self.site_config["eapid"],
            "device": {
                "type": "APP_TABLET"
            },
            "identity": {
                "authState": "ANONYMOUS",
                "duaid": self.device_id,
                "tuid": "-1"
            },
            "privacyTrackingState": "CAN_TRACK",
            "debugContext": {
                "abacusOverrides": []
            }
        }

    def _format_property_id(self, property_id: str) -> str:
        """Format property ID for API request."""
        # Extract numeric part if needed
        numeric_id = "".join(c for c in str(property_id) if c.isdigit())
        return numeric_id

    @async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
    async def fetch_property_summary(
        self,
        property_id: str,
        adults: int = 2,
        children: list = None
    ) -> dict:
        """
        Fetch property summary using PropertySummary query.
        Returns name, location, coordinates, and review info.
        """
        children = children or []
        formatted_property_id = self._format_property_id(property_id)

        search_criteria = {
            "primary": {
                "destination": {"mapBounds": [], "regionName": ""},
                "rooms": [{"adults": adults, "children": children}]
            },
            "secondary": {
                "booleans": [],
                "dates": [],
                "ranges": [],
                "selections": [
                    {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
                    {"id": "productOffersId", "value": str(uuid.uuid4())}
                ]
            }
        }

        payload = {
            "operationName": "PropertySummary",
            "variables": {
                "context": self._build_context(),
                "propertyId": formatted_property_id,
                "searchCriteria": search_criteria
            },
            "query": PROPERTY_SUMMARY_QUERY
        }

        return await self._post_json(
            payload,
            self._get_headers("PropertySummary", "PropertySummary")
        )

    @async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
    async def fetch_property_details(
        self,
        property_id: str,
        check_in: Optional[str] = None,
        check_out: Optional[str] = None,
        adults: int = 2,
        children: list = None
    ) -> dict:
        """Fetch property details using PropertyContent query."""
        children = children or []
        formatted_property_id = self._format_property_id(property_id)

        search_criteria = {
            "primary": {
                "destination": {
                    "mapBounds": [],
                    "regionName": ""
                },
                "rooms": [
                    {
                        "adults": adults,
                        "children": children
                    }
                ]
            },
            "secondary": {
                "booleans": [],
                "dates": [],
                "ranges": [],
                "selections": [
                    {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
                    {"id": "productOffersId", "value": str(uuid.uuid4())}
                ]
            }
        }

        payload = {
            "operationName": "PropertyContent",
            "variables": {
                "context": self._build_context(),
                "propertyId": formatted_property_id,
                "searchCriteria": search_criteria,
                "useNewHostSection": False
            },
            "query": PROPERTY_CONTENT_QUERY
        }

        return await self._post_json(
            payload,
            self._get_headers("PropertyContent", "PropertyContent")
        )

    @async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
    async def fetch_product_gallery(
        self,
        property_id: str
    ) -> dict:
        """Fetch property gallery images using ProductGallery query."""
        formatted_property_id = self._format_property_id(property_id)

        payload = {
            "operationName": "ProductGallery",
            "variables": {
                "context": self._build_context(),
                "productIdentifier": {
                    "id": formatted_property_id,
                    "type": "PROPERTY_ID"
                }
            },
            "query": PRODUCT_GALLERY_QUERY
        }

        return await self._post_json(
            payload,
            self._get_headers("ProductGallery", "ProductGallery")
        )

    @async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
    async def fetch_property_offers(
        self,
        property_id: str,
        check_in: Optional[str] = None,
        check_out: Optional[str] = None,
        adults: int = 2,
        children: list = None
    ) -> dict:
        """Fetch property offers/pricing using PropertyOffers query."""
        children = children or []
        formatted_property_id = self._format_property_id(property_id)

        # Default dates
        if not check_in or not check_out:
            default_checkin, default_checkout = get_default_dates()
            check_in = check_in or default_checkin
            check_out = check_out or default_checkout

        search_criteria = {
            "primary": {
                "dateRange": {
                    "checkInDate": parse_date(check_in),
                    "checkOutDate": parse_date(check_out)
                },
                "destination": {"mapBounds": [], "regionName": ""},
                "rooms": [{"adults": adults, "children": children}]
            },
            "secondary": {
                "booleans": [],
                "dates": [],
                "ranges": [],
                "selections": [
                    {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
                    {"id": "productOffersId", "value": str(uuid.uuid4())}
                ]
            }
        }

        payload = {
            "operationName": "PropertyOffers",
            "variables": {
                "context": self._build_context(),
                "propertyId": formatted_property_id,
                "searchCriteria": search_criteria
            },
            "query": PROPERTY_OFFERS_QUERY
        }

        return await self._post_json(
            payload,
            self._get_headers("PropertyOffers", "PropertyOffers")
        )

    @async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
    async def fetch_review_summary(
        self,
        property_id: str,
        adults: int = 2,
        children: list = None
    ) -> dict:
        """Fetch review summary using ProductReviewSummaryQuery persisted query."""
        children = children or []
        formatted_property_id = self._format_property_id(property_id)

        product_identifier = {
            "id": formatted_property_id,
            "productLine": "LODGING",
            "travelSearchCriteria": {
                "property": {
                    "primary": {
                        "destination": {"mapBounds": [], "regionName": ""},
                        "rooms": [{"adults": adults, "children": children}]
                    },
                    "secondary": {
                        "booleans": [
                            {"id": "isFilteredSummary", "value": True}
                        ],
                        "dates": [],
                        "ranges": [],
                        "selections": [
                            {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
                            {"id": "productOffersId", "value": str(uuid.uuid4())},
                            {"id": "searchTerm", "value": ""},
                            {"id": "popularMention", "value": ""}
                        ]
                    }
                }
            },
            "type": "PROPERTY_ID"
        }

        payload = {
            "operationName": "ProductReviewSummaryQuery",
            "variables": {
                "productIdentifier": product_identifier,
                "context": self._build_context()
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": PRODUCT_REVIEW_SUMMARY_HASH
                }
            }
        }

        return await self._post_json(
            payload,
            self._get_headers("ProductReviewSummaryQuery", PRODUCT_REVIEW_SUMMARY_HASH)
        )

    @async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
    async def fetch_page_layout(
        self,
        property_id: str,
        adults: int = 2,
        children: list = None
    ) -> dict:
        """
        Fetch page layout including rating and review count.
        """
        children = children or []
        formatted_property_id = self._format_property_id(property_id)

        product_identifier = {
            "id": formatted_property_id,
            "productLine": "LODGING",
            "travelSearchCriteria": {
                "property": {
                    "primary": {
                        "destination": {"mapBounds": [], "regionName": ""},
                        "rooms": [{"adults": adults, "children": children}]
                    },
                    "secondary": {
                        "booleans": [],
                        "dates": [],
                        "ranges": [],
                        "selections": [
                            {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
                            {"id": "productOffersId", "value": str(uuid.uuid4())}
                        ]
                    }
                }
            },
            "type": "PROPERTY_ID"
        }

        payload = {
            "operationName": "TemplatePageLayout",
            "variables": {
                "productIdentifier": product_identifier,
                "context": self._build_context()
            },
            "query": TEMPLATE_PAGE_LAYOUT_QUERY
        }

        return await self._post_json(
            payload,
            self._get_headers("TemplatePageLayout", "TemplatePageLayout")
        )


if __name__ == "__main__":
    import json

    async def _test():
        # Test Expedia
        client = ExpediaPropertyClient(site="expedia.com")
        property_id = "12345678"  # Replace with actual property ID

        print(f"Site: {client.base_url}")
        print(f"Property ID: {property_id}")
        print()

        try:
            data = await client.fetch_property_summary(property_id)
            print("Response:")
            print(json.dumps(data, indent=2)[:2000])
        except Exception as e:
            print(f"Error: {e}")

    asyncio.run(_test())
