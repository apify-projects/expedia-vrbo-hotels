#!/usr/bin/env python3
"""
Expedia URL Parser

Extracts property IDs from Expedia, Hotels.com, and Vrbo URLs.
"""

import re
from typing import Optional, Tuple
from urllib.parse import urlparse

# Import Hotels.com converter (lazy import to avoid circular dependencies)
_hotels_converter = None

def _get_hotels_converter():
    """Lazy load Hotels.com converter."""
    global _hotels_converter
    if _hotels_converter is None:
        from hotels_com_converter import convert_hotels_com_to_expedia
        _hotels_converter = convert_hotels_com_to_expedia
    return _hotels_converter


class URLParseError(Exception):
    """Raised when a URL cannot be parsed."""
    pass


def extract_property_id(url: str) -> Tuple[str, str]:
    """
    Extract property ID and platform from Expedia/Hotels.com/Vrbo URL.

    Args:
        url: Full URL to a property page

    Returns:
        Tuple of (property_id, platform)
        - property_id: The numeric ID of the property
        - platform: One of 'expedia', 'hotels.com', 'vrbo'

    Raises:
        URLParseError: If URL format is not recognized

    Examples:
        >>> extract_property_id("https://www.expedia.com/Prague-Hotels.h525006.Hotel-Information")
        ('525006', 'expedia')

        >>> extract_property_id("https://www.hotels.com/ho136900/hilton-prague")
        ('136900', 'hotels.com')

        >>> extract_property_id("https://www.vrbo.com/1234567")
        ('1234567', 'vrbo')
    """
    if not url or not isinstance(url, str):
        raise URLParseError(f"Invalid URL: {url}")

    # Parse URL to get domain
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
    except Exception as e:
        raise URLParseError(f"Failed to parse URL: {url} - {e}")

    # Expedia formats (all international domains)
    # Pattern: .h{ID}.Hotel-Information
    # Examples:
    # - expedia.com/...h525006.Hotel-Information
    # - expedia.it/en/...h2692552.Hotel-Information
    # - expedia.co.uk/...h123456.Hotel-Information
    if 'expedia' in domain:
        # Match standard ".h12345." pattern or "/h12345." fallback
        match = re.search(r'[./]h(\d+)\.', url)
        if match:
            return (match.group(1), 'expedia')

        # Try alternative format (sometimes without trailing dot)
        match = re.search(r'\.h(\d+)', url)
        if match:
            return (match.group(1), 'expedia')

        raise URLParseError(f"Could not extract property ID from Expedia URL: {url}")

    # Hotels.com format
    # Pattern: /ho{ID}/hotel-name
    # Example: hotels.com/ho136900/hilton-prague-old-town-prague
    elif 'hotels.com' in domain:
        match = re.search(r'/ho(\d+)/', url)
        if match:
            return (match.group(1), 'hotels.com')

        # Try without trailing slash
        match = re.search(r'/ho(\d+)', url)
        if match:
            return (match.group(1), 'hotels.com')

        raise URLParseError(f"Could not extract property ID from Hotels.com URL: {url}")

    # Vrbo format
    # Pattern: vrbo.com/{ID} or vrbo.com/rental/{ID}
    # Examples:
    # - vrbo.com/1234567
    # - vrbo.com/rental/1234567
    elif 'vrbo' in domain or 'homeaway' in domain or 'abritel' in domain or 'fewo-direkt' in domain or 'bookabach' in domain or 'stayz' in domain:
        # Try rental path first
        match = re.search(r'/rental/(\d+)', url)
        if match:
            return (match.group(1), 'vrbo')

        # Try /p{ID}{suffix} pattern
        match = re.search(r'/p(\d+)[a-z]*(?:/|$|\?)', url, re.IGNORECASE)
        if match:
            return (match.group(1), 'vrbo')

        # Try direct ID
        match = re.search(r'/(\d+)', url)
        if match:
            return (match.group(1), 'vrbo')

        raise URLParseError(f"Could not extract property ID from Vrbo URL: {url}")

    else:
        raise URLParseError(f"Unsupported domain: {domain}")


def validate_url(url: str) -> bool:
    """
    Check if URL is a valid Expedia/Hotels.com/Vrbo property URL.

    Args:
        url: URL to validate

    Returns:
        True if URL can be parsed, False otherwise
    """
    try:
        extract_property_id(url)
        return True
    except URLParseError:
        return False


def detect_platform(url: str) -> Optional[str]:
    """
    Detect platform from URL without extracting ID.

    Returns:
        'vrbo', 'expedia', or 'hotels.com', or None if not recognized
    """
    try:
        _, platform = extract_property_id(url)
        return platform
    except URLParseError:
        return None


def get_expedia_property_id(url: str, client=None, logger=None, proxies=None) -> str:
    """
    Extract Expedia-compatible property ID from any supported URL.

    For Hotels.com URLs, automatically converts the Hotels.com ID to
    an Expedia property ID using the Hotels.com search API.

    Args:
        url: Full URL to a property page
        client: Optional client instance (for Hotels.com conversion)
        logger: Optional logger
        proxies: Optional proxy configuration

    Returns:
        Expedia property ID (string)

    Raises:
        URLParseError: If URL format is not recognized
        Exception: If Hotels.com conversion fails
    """
    # First extract the raw ID and platform
    property_id, platform = extract_property_id(url)

    # If it's already an Expedia URL, return the ID directly
    if platform == 'expedia':
        return property_id

    # For Hotels.com URLs, convert to Expedia ID
    elif platform == 'hotels.com':
        if logger:
            logger.info(f"Converting Hotels.com URL to Expedia property ID...")
        else:
            print(f"Converting Hotels.com URL to Expedia property ID...")

        converter = _get_hotels_converter()
        expedia_id = converter(url, client, logger=logger, proxies=proxies)

        if not expedia_id:
            raise URLParseError(
                f"Failed to convert Hotels.com URL to Expedia property ID: {url}"
            )

        return expedia_id

    # Vrbo URLs use their own API
    elif platform == 'vrbo':
        raise URLParseError(
            "Vrbo URLs should be handled by VrboPropertyClient, not converted to Expedia IDs."
        )

    else:
        raise URLParseError(f"Unsupported platform: {platform}")


if __name__ == "__main__":
    # Test cases
    test_urls = [
        # Expedia formats
        "https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information?chkin=2023-03-17&chkout=2023-03-18",
        "https://www.expedia.it/en/Berchtesgaden-Hotels-Alpensport-Hotel-Seimler.h2692552.Hotel-Information",
        "https://www.expedia.com/Prague-Hotels-Hotel-Krystal.h10966026.Hotel-Information",

        # Hotels.com format
        "https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/",

        # Vrbo formats
        "https://www.vrbo.com/1234567",
        "https://www.vrbo.com/rental/9876543",
        "https://www.vrbo.com/en-us/vacation-rental/p1234567vb",
    ]

    print("URL Parser Test Suite")
    print("=" * 80)
    print()

    for url in test_urls:
        try:
            property_id, platform = extract_property_id(url)
            print(f"✓ {platform:12s} | ID: {property_id:10s} | {url[:60]}...")
        except URLParseError as e:
            print(f"✗ ERROR: {e}")
