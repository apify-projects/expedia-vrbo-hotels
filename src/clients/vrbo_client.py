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

import httpx
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
# NOTE: vrbo.com must use vrbo.com endpoint with numeric IDs (not path format).
# The bookabach.co.nz endpoint returns incorrect property data for some IDs.
SITE_CONFIGS = {
    "vrbo.com": {"base_url": "https://www.vrbo.com", "site_id": 9001001, "tpid": 9001, "eapid": 1, "locale": "en_US", "currency": "USD"},
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


# Short URL domains that redirect to VRBO property pages
SHORT_URL_DOMAINS = {"t.vrbo.io", "vrbo.io", "homeaway.com/vl"}


def is_short_url(url: str) -> bool:
    """Check if URL is a short/redirect URL that needs resolution."""
    if not url.startswith("http"):
        return False
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    return any(domain in host for domain in SHORT_URL_DOMAINS)


async def resolve_short_url(url: str, proxy_url: Optional[str] = None) -> str:
    """Resolve short URLs (like t.vrbo.io) to full VRBO property URLs.

    Short URLs from sharing or marketing redirect through multiple services.
    We follow redirects and extract the final VRBO URL or property ID.

    Args:
        url: Short URL to resolve (e.g., https://t.vrbo.io/bN81iIoI3Wb)
        proxy_url: Optional proxy URL

    Returns:
        Resolved full URL or original URL if resolution fails
    """
    if not is_short_url(url):
        return url

    try:
        session = tls_client.Session(
            client_identifier="okhttp4_android_13",
            random_tls_extension_order=True
        )

        if proxy_url:
            session.proxies = {"http": proxy_url, "https": proxy_url}

        # First request to get initial redirect
        response = await asyncio.wait_for(
            asyncio.to_thread(
                session.get,
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml",
                },
                allow_redirects=False  # Don't follow redirects automatically
            ),
            timeout=15.0
        )

        # Check for redirect in Location header (tls_client headers are case-sensitive)
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("Location") or response.headers.get("location", "")
            if location:
                # If redirects to another short URL service, follow it
                if "app.link" in location or "branch.io" in location:
                    # Branch.io links - may redirect directly or serve HTML with fallback URL
                    branch_response = await asyncio.wait_for(
                        asyncio.to_thread(
                            session.get,
                            location,
                            headers={
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                                "Accept": "text/html",
                            },
                            allow_redirects=False
                        ),
                        timeout=15.0
                    )

                    # Check if Branch.io returns a redirect with VRBO URL in Location header
                    if branch_response.status_code in (301, 302, 303, 307, 308):
                        branch_location = branch_response.headers.get("Location") or branch_response.headers.get("location", "")
                        if branch_location and ("vrbo.com" in branch_location or any(site in branch_location for site in SITE_CONFIGS)):
                            return branch_location

                    # Fall back to parsing HTML for browser_fallback_url
                    html = branch_response.text

                    # Extract fallback URL from Branch.io page
                    # Pattern: browser_fallback_url=https%3A%2F%2Fwww.vrbo.com%2F...
                    match = re.search(r'browser_fallback_url=([^&"\'>\s]+)', html)
                    if match:
                        from urllib.parse import unquote
                        fallback_url = unquote(match.group(1))
                        if "vrbo.com" in fallback_url or any(site in fallback_url for site in SITE_CONFIGS):
                            return fallback_url

                    # Alternative: Look for vrbo.com URL in the HTML
                    match = re.search(r'https?://(?:www\.)?vrbo\.com/[^\s"\'<>]+', html)
                    if match:
                        return match.group(0).rstrip('\\')

                # Direct redirect to VRBO
                if "vrbo.com" in location or any(site in location for site in SITE_CONFIGS):
                    return location

        # If we got HTML response, look for property URL in content
        if response.status_code == 200:
            html = response.text
            match = re.search(r'https?://(?:www\.)?vrbo\.com/[^\s"\'<>]+', html)
            if match:
                return match.group(0).rstrip('\\')

        return url

    except Exception:
        return url


async def resolve_legacy_property_id(url: str, property_id: str, suffix: str, proxy_url: Optional[str] = None) -> str:
    """Resolve legacy HomeAway property ID to internal VRBO property ID.

    Legacy HomeAway URLs use a different ID system that requires server-side resolution.
    The GraphQL API only accepts internal numeric IDs.

    This affects:
    - URLs with 'ha' suffix: /11887139ha
    - Localized URLs without suffix: /en-gb/p11887139 (still legacy IDs!)

    The internal ID is embedded in the page HTML within various patterns:
    - Image URLs: /lodging/118000000/117900000/117899000/117898910/image.jpg
    - Meta tags: <meta itemprop="identifier" content="117898910">
    - Script data: "propertyId":"117898910"

    For example: URL ID '11887139' or '11887139ha' maps to internal ID '117898910'.

    Args:
        url: Original VRBO URL
        property_id: Extracted numeric property ID from URL
        suffix: ID suffix ('ha', 'vb', 'a', or '')
        proxy_url: Optional proxy URL

    Returns:
        Internal property ID (numeric string)
    """
    # Skip resolution for IDs that are clearly internal VRBO IDs (typically 7+ digits starting with 1-9)
    # Legacy HomeAway IDs are typically 7-8 digits, internal IDs are 9 digits
    # However, we can't reliably distinguish, so we always try resolution for 'ha' suffix
    # and for shorter IDs that might be legacy

    # 'vb' suffix IDs are native VRBO and don't need resolution
    if suffix == "vb":
        return property_id

    try:
        # Construct the URL to fetch
        fetch_url = url if url.startswith("http") else f"https://www.vrbo.com/{property_id}{suffix}"

        # Use tls_client with mobile Android fingerprint for better anti-bot evasion
        session = tls_client.Session(
            client_identifier="okhttp4_android_13",
            random_tls_extension_order=True
        )

        if proxy_url:
            session.proxies = {"http": proxy_url, "https": proxy_url}

        # Use mobile app user-agent (same as GraphQL requests) for consistency
        response = await asyncio.wait_for(
            asyncio.to_thread(
                session.get,
                fetch_url,
                headers={
                    "User-Agent": "HomeAway/2025.47.0 Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Accept-Encoding": "gzip, deflate",
                },
                allow_redirects=True
            ),
            timeout=20.0
        )
        html = response.text

        # Method 1: Extract from og:image URL pattern (most reliable)
        # Pattern: /lodging/118000000/117900000/117899000/117898910/image.jpg
        match = re.search(r'/lodging/\d+/\d+/\d+/(\d+)/', html)
        if match:
            internal_id = match.group(1)
            if internal_id != property_id:  # Ensure we found a different ID
                return internal_id

        # Method 2: Extract from <meta itemprop="identifier" content="...">
        # Attribute order may vary, so use flexible pattern
        match = re.search(r'<meta[^>]*itemprop=["\']identifier["\'][^>]*content=["\'](\d+)["\']', html)
        if match:
            return match.group(1)
        match = re.search(r'<meta[^>]*content=["\'](\d+)["\'][^>]*itemprop=["\']identifier["\']', html)
        if match:
            return match.group(1)

        # Method 3: Extract from JSON-LD or script data
        # Pattern: "propertyId":"117898910" or "id":"117898910"
        match = re.search(r'"propertyId"\s*:\s*"(\d+)"', html)
        if match:
            internal_id = match.group(1)
            if internal_id != property_id:
                return internal_id

        # Method 4: Extract from data attributes
        # Pattern: data-property-id="117898910"
        match = re.search(r'data-property-id=["\'](\d+)["\']', html)
        if match:
            internal_id = match.group(1)
            if internal_id != property_id:
                return internal_id

        # Method 5: Extract from canonical URL or og:url if it contains different ID
        match = re.search(r'(?:canonical|og:url)[^>]*href=["\'][^"\']*?/(\d+)(?:["\']|[?/])', html)
        if match:
            internal_id = match.group(1)
            if internal_id != property_id and len(internal_id) >= 6:
                return internal_id

        # If no internal ID found, return original (API will fail if invalid)
        return property_id

    except Exception as e:
        # If resolution fails, try with the original ID
        return property_id


def validate_property_response(response_data: dict, expected_id: str) -> tuple[bool, str]:
    """Validate that API response is for the correct property.

    The GraphQL response includes the property ID at data.propertyInfo.summary.id.
    This function checks that the returned ID matches what we requested,
    detecting cases where an endpoint returns data for a different property.

    Args:
        response_data: Raw GraphQL response dictionary
        expected_id: The property ID we requested (may include suffix)

    Returns:
        Tuple of (is_valid, reason) where:
        - is_valid: True if response matches expected property
        - reason: Explanation (especially useful when invalid)
    """
    # Extract response property info
    property_info = response_data.get("data", {}).get("propertyInfo", {})
    summary = property_info.get("summary", {})
    response_id = summary.get("id")
    response_name = summary.get("name")

    # Check for empty response
    if not response_id and not response_name:
        return False, "Empty response - no property ID or name returned"

    # Normalize IDs for comparison (strip any suffix)
    expected_num = re.sub(r'[a-zA-Z]+$', '', str(expected_id))
    response_num = re.sub(r'[a-zA-Z]+$', '', str(response_id)) if response_id else ""

    # Check if IDs match
    if response_num and expected_num != response_num:
        return False, f"Wrong property: requested {expected_id}, got {response_id} ('{response_name}')"

    return True, "Valid"


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

        Note: The GraphQL API only accepts numeric IDs. Legacy HomeAway IDs
        (with 'ha' suffix) must be resolved to internal IDs BEFORE calling
        this method using resolve_legacy_property_id().

        Args:
            property_id: The property ID (should already be resolved for 'ha' URLs)
            suffix: Ignored - kept for API compatibility

        Returns:
            Numeric property ID string
        """
        # Extract numeric part only - API doesn't accept suffixes
        return "".join(c for c in property_id if c.isdigit())

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

        data = await self._post_json(
            payload,
            self._get_headers("PropertySummary", "PropertySummary")
        )

        # Validate that we got the correct property (not wrong data from mismatched endpoint)
        is_valid, reason = validate_property_response(data, formatted_property_id)
        if not is_valid:
            raise ValueError(f"Property validation failed for {formatted_property_id}: {reason}")

        return data

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
        """Fetch property gallery images using ProductGallery query.

        Note: ProductGallery API requires raw numeric ID, not the formatted path.
        """
        # Extract just the numeric part - ProductGallery doesn't accept path format
        numeric_id = "".join(c for c in property_id if c.isdigit())

        payload = {
            "operationName": "ProductGallery",
            "variables": {
                "context": self._build_context(),
                "productIdentifier": {
                    "id": numeric_id,
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
        """Fetch review summary using ProductReviewSummaryQuery persisted query.

        Note: This API requires raw numeric ID, not the formatted path.
        """
        children = children or []
        # Extract just the numeric part - this API doesn't accept path format
        numeric_id = "".join(c for c in property_id if c.isdigit())

        product_identifier = {
            "id": numeric_id,
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
