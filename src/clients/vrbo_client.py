"""
GraphQL client for VRBO/HomeAway property details API.

Uses full GraphQL queries extracted from the VRBO Android app.
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

    Uses asyncio.sleep to avoid blocking the event loop during backoff.
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


# Regional site configurations
# NOTE: vrbo.com uses bookabach.co.nz GraphQL endpoint because vrbo.com endpoint
# fails to resolve property IDs with "Could not resolve EG url" errors.
# The bookabach.co.nz endpoint works for all VRBO properties regardless of region.
SITE_CONFIGS = {
    "vrbo.com": {"base_url": "https://www.bookabach.co.nz", "site_id": 9006043, "tpid": 9006, "eapid": 43, "locale": "en_US", "currency": "USD"},
    "bookabach.co.nz": {"base_url": "https://www.bookabach.co.nz", "site_id": 9006043, "tpid": 9006, "eapid": 43, "locale": "en_NZ", "currency": "NZD"},
    "stayz.com.au": {"base_url": "https://www.stayz.com.au", "site_id": 9006044, "tpid": 9006, "eapid": 44, "locale": "en_AU", "currency": "AUD"},
    "abritel.fr": {"base_url": "https://www.abritel.fr", "site_id": 9001020, "tpid": 9001, "eapid": 20, "locale": "en_US", "currency": "EUR"},
    "fewo-direkt.de": {"base_url": "https://www.fewo-direkt.de", "site_id": 9001030, "tpid": 9001, "eapid": 30, "locale": "en_US", "currency": "EUR"},
}


def detect_site_from_url(url: str) -> Optional[str]:
    """Detect site key from URL domain."""
    if not url.startswith("http"):
        return None
    parsed = urlparse(url)
    host = parsed.netloc.lower().replace("www.", "")
    for site_key in SITE_CONFIGS:
        if site_key in host:
            return site_key
    return None


def extract_property_id_from_url(url: str) -> tuple[Optional[str], Optional[str]]:
    """
    Extract property ID from various VRBO URL formats.

    Supported formats:
    - https://www.vrbo.com/1234567
    - https://www.vrbo.com/10739791ha
    - https://www.vrbo.com/nl-nl/vakantiewoning/p2093105a
    - https://www.vrbo.com/en-us/vacation-rental/p1234567vb
    - https://www.vrbo.com/en-gb/p11348801
    - https://www.bookabach.co.nz/holiday-homes/p497962vb

    Returns:
        Tuple of (numeric_id, suffix) or (None, None)
    """
    # Clean URL
    url = url.strip().rstrip('"\'')

    if not url.startswith("http"):
        return None, None

    parsed = urlparse(url)
    path = parsed.path.strip("/")

    # Pattern 1: /p{ID}{suffix} anywhere in path
    match = re.search(r'/p(\d+)([a-z]*)(?:/|$|\?)', "/" + path + "/", re.IGNORECASE)
    if match:
        numeric_id = match.group(1)
        suffix = match.group(2).lower() if match.group(2) else ""
        return numeric_id, suffix

    # Pattern 2: Numeric ID with optional suffix at start/end of path
    match = re.search(r'(?:^|/)(\d+)([a-z]{0,3})(?:/|$)', path, re.IGNORECASE)
    if match:
        numeric_id = match.group(1)
        suffix = match.group(2).lower() if match.group(2) else ""
        return numeric_id, suffix

    return None, None


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


class VrboPropertyClient:
    """Client for fetching property details from VRBO GraphQL API."""

    def __init__(
        self,
        site: str = "vrbo.com",
        currency: Optional[str] = None,
        proxy_url: Optional[str] = None,
        timeout: float = 30.0
    ):
        """
        Initialize client for a specific regional site.

        Args:
            site: Site key from SITE_CONFIGS (e.g., 'vrbo.com', 'bookabach.co.nz')
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

        headers = {
            "accept": "multipart/mixed;deferSpec=20220824, application/graphql-response+json, application/json",
            "content-type": "application/json",
            "user-agent": "HomeAway/2025.47.0 Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)",
            "client-info": "android.com.vacationrentals.homeaway,2025.47.0,external",
            "device-user-agent-id": self.device_id,
            "x-eb-client": f"PLATFORM:ANDROID;OS_VERSION:13;MANUFACTURER:unknown;MODEL:Generic Android-x86_64;MODEL_NAME:Generic Android-x86_64;UPGRADE:false;APP_VERSION:2025.47.0;LOCALE:{locale};APP_IDENTIFIER:com.vacationrentals.homeaway;",
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
                "name": "android.com.vacationrentals.homeaway",
                "version": "2025.47.0"
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
                "abacusOverrides": [
                    {"bucket": 1, "id": "25805"},
                    {"bucket": 1, "id": "31491"},
                    {"bucket": 1, "id": "31619"}
                ]
            }
        }

    def _format_property_id(self, property_id: str, suffix: str = "") -> str:
        """Format property ID for API request.

        Note: The API expects IDs WITHOUT suffix (e.g., /holiday-accommodation/p1234567).
        Suffixes like 'ha', 'vb', 'a' are URL-specific and cause API errors.
        """
        # If already formatted, return as-is
        if property_id.startswith("/holiday-accommodation/"):
            return property_id

        # Extract numeric part only - suffixes cause API errors
        numeric_id = "".join(c for c in property_id if c.isdigit())

        return f"/holiday-accommodation/p{numeric_id}"

    @async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
    async def fetch_property_summary(
        self,
        property_id: str,
        suffix: str = "",
        adults: int = 2,
        children: list = None
    ) -> dict:
        """
        Fetch property summary using PropertySummary query.
        Returns name, location, coordinates, and review info.
        """
        children = children or []
        formatted_property_id = self._format_property_id(property_id, suffix)

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
        suffix: str = "",
        check_in: Optional[str] = None,
        check_out: Optional[str] = None,
        adults: int = 2,
        children: list = None
    ) -> dict:
        """Fetch property details using PropertyContent query."""
        children = children or []
        formatted_property_id = self._format_property_id(property_id, suffix)

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
        property_id: str,
        suffix: str = ""
    ) -> dict:
        """Fetch property gallery images using ProductGallery query."""
        formatted_property_id = self._format_property_id(property_id, suffix)

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
        suffix: str = "",
        check_in: Optional[str] = None,
        check_out: Optional[str] = None,
        adults: int = 2,
        children: list = None
    ) -> dict:
        """Fetch property offers/pricing using PropertyOffers query."""
        children = children or []
        formatted_property_id = self._format_property_id(property_id, suffix)

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
        suffix: str = "",
        adults: int = 2,
        children: list = None
    ) -> dict:
        """Fetch review summary using ProductReviewSummaryQuery persisted query."""
        children = children or []
        formatted_property_id = self._format_property_id(property_id, suffix)

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
        suffix: str = "",
        adults: int = 2,
        children: list = None
    ) -> dict:
        """
        Fetch page layout including rating and review count.

        Returns the TemplatePageLayout config which contains seoStructuredData
        with aggregateRating (ratingValue, reviewCount, bestRating).
        """
        children = children or []
        formatted_property_id = self._format_property_id(property_id, suffix)

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
        client = VrboPropertyClient(site="vrbo.com")
        property_id = "4084796"

        print(f"Site: {client.base_url}")
        print(f"Property ID: {property_id}")
        print()

        try:
            data = await client.fetch_property_details(property_id)
            print("Response:")
            print(json.dumps(data, indent=2)[:2000])
        except Exception as e:
            print(f"Error: {e}")

    asyncio.run(_test())
