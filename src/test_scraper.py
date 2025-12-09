#!/usr/bin/env python3
"""Simple test script for the unified property scraper."""

import asyncio
import sys
import os

# Add src to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from url_parser import detect_platform
from clients.vrbo_client import VrboPropertyClient, detect_site_from_url as vrbo_detect_site, extract_property_id_from_url as vrbo_extract_id
from clients.expedia_client import ExpediaPropertyClient, detect_site_from_url as expedia_detect_site
from formatters.vrbo_formatter import format_property

TEST_URLS = [
    "https://www.vrbo.com/4084796",
    "https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information",
    "https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/",
]


async def test_vrbo(url: str):
    """Test VRBO scraping."""
    site = vrbo_detect_site(url) or "vrbo.com"
    property_id, suffix = vrbo_extract_id(url)

    client = VrboPropertyClient(site=site)

    # Fetch data
    summary = await client.fetch_property_summary(property_id, suffix)
    details = await client.fetch_property_details(property_id, suffix)
    gallery = await client.fetch_product_gallery(property_id, suffix)

    return format_property(
        summary_data=summary,
        details_data=details,
        gallery_data=gallery,
        url=url
    )


async def test_expedia(url: str, site: str = "expedia.com"):
    """Test Expedia/Hotels.com scraping."""
    import re
    # Extract property ID from URL
    match = re.search(r'\.h(\d+)\.', url) or re.search(r'/ho(\d+)', url)
    if not match:
        raise ValueError(f"Could not extract ID from: {url}")
    property_id = match.group(1)

    client = ExpediaPropertyClient(site=site)

    # Fetch data
    summary = await client.fetch_property_summary(property_id)
    details = await client.fetch_property_details(property_id)
    gallery = await client.fetch_product_gallery(property_id)

    return format_property(
        summary_data=summary,
        details_data=details,
        gallery_data=gallery,
        url=url
    )


async def test():
    """Run tests for all platforms."""
    for url in TEST_URLS:
        print(f"\n{'='*60}")
        print(f"Testing: {url}")
        print('='*60)

        platform = detect_platform(url)
        print(f"Platform: {platform}")

        try:
            if platform == "vrbo":
                result = await test_vrbo(url)
            elif platform == "expedia":
                result = await test_expedia(url, "expedia.com")
            elif platform == "hotels.com":
                result = await test_expedia(url, "hotels.com")
            else:
                print(f"✗ Unknown platform: {platform}")
                continue

            print(f"✓ Name: {result.get('name')}")
            print(f"✓ Location: {result.get('location', {}).get('city')}")
            print(f"✓ Rating: {result.get('rating')}")
            print(f"✓ Images: {len(result.get('images', []))} found")

        except Exception as e:
            print(f"✗ Error: {e}")
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test())
