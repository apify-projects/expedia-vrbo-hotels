#!/usr/bin/env python3
"""
Hotels.com to Expedia ID Converter

Extracts Expedia property ID from Hotels.com URLs by:
1. Fetching the Hotels.com page HTML with proper TLS fingerprint
2. Extracting propertyId from embedded JavaScript state

Uses curl_cffi to match Android Chrome TLS signature for proper mobile impersonation.
"""

import re
import json
from typing import Optional, Any
from collections import Counter
from urllib.parse import urlparse, parse_qs
from curl_cffi import requests
from curl_cffi.requests import exceptions as req_exc


class HotelsComDelistedError(Exception):
    """Raised when a Hotels.com URL redirects away from its property page.

    Hotels.com 301-redirects unknown / delisted hotel IDs to the homepage (or to
    a region page), so there is no property page to read the Expedia ID from.
    This is a dead input ID, not a scraper failure.
    """
    pass


def extract_expedia_id_from_url(hotels_com_url: str) -> Optional[str]:
    """Extract Expedia property ID directly from the URL query string.

    Hotels.com search/detail URLs often carry the Expedia ID as a query param
    (e.g. ?expediaPropertyId=615323 or &selected=615323). When present we can
    skip the page fetch entirely.
    """
    try:
        qs = parse_qs(urlparse(hotels_com_url).query)
    except Exception:
        return None
    for key in ('expediaPropertyId', 'selected'):
        vals = qs.get(key)
        if vals and vals[0].isdigit():
            return vals[0]
    return None


# Headers mimicking Hotels.com mobile app
HOTELS_COM_HEADERS = {
    'User-Agent': 'HCom/2025.46.0 Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
}

# Request timeout (seconds)
REQUEST_TIMEOUT = 30

# TLS impersonation - use chrome120 for Android Chrome signature
TLS_IMPERSONATE = 'chrome120'


def extract_expedia_id_from_hotels_com_html(
    hotels_com_url: str,
    proxies: Optional[Any] = None
) -> Optional[str]:
    """
    Fetch Hotels.com page and extract Expedia property ID from HTML/JavaScript.

    Uses curl_cffi with proper TLS fingerprint to avoid detection.

    Args:
        hotels_com_url: Full Hotels.com URL (e.g., https://www.hotels.com/ho136900/...)
        proxies: Optional proxy configuration

    Returns:
        Expedia property ID if found, None otherwise
    """
    try:
        proxy_dict = {"http": proxies, "https": proxies} if isinstance(proxies, str) else proxies
        response = requests.get(
            hotels_com_url,
            headers=HOTELS_COM_HEADERS,
            timeout=REQUEST_TIMEOUT,
            impersonate=TLS_IMPERSONATE,
            allow_redirects=True,
            proxies=proxy_dict
        )
        response.raise_for_status()

        # Hotels.com 301s delisted/unknown hotel IDs to the homepage or to a region
        # page. If the original URL named a /ho<id> property but the final URL no
        # longer contains a /ho<id> path, the listing is gone — fail loudly instead
        # of returning None (which reads as a converter bug).
        orig_match = re.search(r'/ho\d+', urlparse(hotels_com_url).path)
        if orig_match:
            final_path = urlparse(str(response.url)).path
            if not re.search(r'/ho\d+', final_path):
                raise HotelsComDelistedError(
                    f"Hotels.com no longer lists this property "
                    f"(ID {orig_match.group(0).lstrip('/ho')}); "
                    f"{hotels_com_url} redirected to {response.url}"
                )

        html = response.text

        # Most reliable: clean (unescaped) meta tag rendered on every property page
        # <meta itemProp="identifier" content="615323"/>
        pattern0 = r'itemProp=["\']identifier["\'][^>]*content=["\'](\d+)'
        matches = re.findall(pattern0, html)
        if matches:
            return matches[0]

        # product_details?productId=615323 — appears many times in embedded state
        pattern_pid = r'productId[\\"\']*[:=][\\"\']*(\d+)'
        matches = re.findall(pattern_pid, html)
        if matches:
            return Counter(matches).most_common(1)[0][0]

        # Try expediaPropertyId pattern (allows backslash-escaped JSON quotes)
        pattern1 = r'expediaPropertyId[\\"\']*\s*[:=]\s*[\\"\']*(\d+)'
        matches = re.findall(pattern1, html)
        if matches:
            return matches[0]

        # Try JSON-LD structured data
        pattern2 = r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>'
        json_ld_blocks = re.findall(pattern2, html, re.DOTALL)
        for block in json_ld_blocks[:3]:
            try:
                data = json.loads(block)
                if isinstance(data, dict):
                    for key in ['identifier', '@id', 'propertyId']:
                        if key in data and isinstance(data[key], (str, int)):
                            value = str(data[key])
                            if value.isdigit():
                                return value
            except json.JSONDecodeError:
                continue

        # Try propertyId in JavaScript state
        pattern3 = r'propertyId["\']?\s*[:=]\s*["\']?(\d+)'
        matches = re.findall(pattern3, html)
        if matches:
            most_common = Counter(matches).most_common(1)
            if most_common:
                return most_common[0][0]

        # Try data-property-id attribute
        pattern4 = r'data-property-id=["\'](\d+)["\']'
        matches = re.findall(pattern4, html)
        if matches:
            return matches[0]

        # Try meta tags
        pattern5 = r'<meta[^>]*(?:name|property)=["\'](?:expedia:)?property[_-]?id["\'][^>]*content=["\'](\d+)["\']'
        matches = re.findall(pattern5, html, re.IGNORECASE)
        if matches:
            return matches[0]

        # Try hotelId patterns
        pattern6 = r'(?:propertyId|hotelId|property_id)["\']?\s*[:=]\s*["\']?(\d+)'
        matches = re.findall(pattern6, html)
        if matches:
            most_common = Counter(matches).most_common(1)
            if most_common:
                return most_common[0][0]

        return None

    except HotelsComDelistedError:
        raise
    except req_exc.RequestException:
        return None
    except Exception:
        return None


def convert_hotels_com_to_expedia(
    hotels_com_url: str,
    proxies: Optional[Any] = None
) -> Optional[str]:
    """
    Convert Hotels.com URL to Expedia property ID using HTML extraction.

    Args:
        hotels_com_url: Hotels.com URL (e.g., https://www.hotels.com/ho136900/...)
        proxies: Optional proxy configuration

    Returns:
        Expedia property ID (e.g., "21856") or None if not found
    """
    # Cheap path: ID already present in the URL query string — skip the fetch.
    from_url = extract_expedia_id_from_url(hotels_com_url)
    if from_url:
        return from_url

    return extract_expedia_id_from_hotels_com_html(hotels_com_url, proxies=proxies)


if __name__ == "__main__":
    """Test the converter with HTML extraction."""
    print("=" * 80)
    print("Hotels.com to Expedia ID Converter - HTML Extraction Test")
    print("=" * 80)
    print()

    test_url = "https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/"

    print(f"Converting: {test_url}")
    print()

    expedia_id = convert_hotels_com_to_expedia(test_url)

    print()
    print("=" * 80)
    print("RESULT")
    print("=" * 80)

    if expedia_id:
        print(f"✓ Extracted Expedia property ID: {expedia_id}")
        print(f"  Expected: 21856")
        print(f"  Match: {'✓' if expedia_id == '21856' else '✗'}")
    else:
        print("✗ Failed to extract Expedia property ID")

    print()
    print("=" * 80)
