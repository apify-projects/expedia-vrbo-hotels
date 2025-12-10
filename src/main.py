#!/usr/bin/env python3
"""
Unified Property Scraper for VRBO, Expedia, and Hotels.com.

Scrapes property details from any of the three platforms,
auto-detecting the platform from the URL.
"""

import asyncio
import os
import re
import sys
from typing import Optional
from urllib.parse import urlparse

import httpx

from apify import Actor

# Add src to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from url_parser import extract_property_id, URLParseError, detect_platform
from clients.vrbo_client import VrboPropertyClient, detect_site_from_url as vrbo_detect_site, extract_property_id_from_url as vrbo_extract_id
from clients.expedia_client import ExpediaPropertyClient, detect_site_from_url as expedia_detect_site
from formatters.vrbo_formatter import format_property, format_error


# Short URL domains that need resolution
SHORT_URL_DOMAINS = {"t.vrbo.io", "vrbo.io", "t.expedia.com", "t.hotels.com"}


async def resolve_short_url(url: str, proxy_url: Optional[str] = None) -> str:
    """
    Resolve short URLs (t.vrbo.io, etc.) to their final destination.

    These short URLs use JavaScript redirects, so we need to parse the HTML
    to extract the actual URL.
    """
    parsed = urlparse(url)
    if parsed.netloc not in SHORT_URL_DOMAINS:
        return url

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            response = await client.get(url)
            html = response.text

            # Look for VRBO/Expedia/Hotels.com URLs in the HTML
            patterns = [
                r'https://www\.vrbo\.com[^"<>\s]+',
                r'https://www\.expedia\.com[^"<>\s]+',
                r'https://www\.hotels\.com[^"<>\s]+',
            ]

            for pattern in patterns:
                match = re.search(pattern, html)
                if match:
                    # Decode HTML entities
                    resolved = match.group(0)
                    resolved = resolved.replace("&#x3D;", "=")
                    resolved = resolved.replace("&amp;", "&")
                    resolved = resolved.replace("&#x26;", "&")
                    return resolved

    except Exception as e:
        raise URLParseError(f"Failed to resolve short URL {url}: {e}")

    raise URLParseError(f"Could not find destination URL in short URL response: {url}")


async def scrape_vrbo_property(url: str, proxy_url: Optional[str] = None) -> dict:
    """Scrape a VRBO/HomeAway property."""
    site = vrbo_detect_site(url) or "vrbo.com"
    property_id, suffix = vrbo_extract_id(url)
    if not property_id:
        raise ValueError(f"Could not extract property ID from VRBO URL: {url}")

    client = VrboPropertyClient(site=site, proxy_url=proxy_url)

    # Fetch all required data in parallel
    summary_data, details_data, gallery_data, offers_data, page_layout_data = await asyncio.gather(
        client.fetch_property_summary(property_id, suffix),
        client.fetch_property_details(property_id, suffix),
        client.fetch_product_gallery(property_id, suffix),
        client.fetch_property_offers(property_id, suffix),
        client.fetch_page_layout(property_id, suffix)
    )

    return format_property(
        summary_data=summary_data,
        content_data=details_data,
        url=url,
        property_id=property_id,
        gallery_data=gallery_data,
        offers_data=offers_data,
        page_layout_data=page_layout_data
    )


async def scrape_expedia_property(url: str, proxy_url: Optional[str] = None) -> dict:
    """Scrape an Expedia property."""
    site = expedia_detect_site(url) or "expedia.com"
    property_id, platform = extract_property_id(url)
    if not property_id:
        raise ValueError(f"Could not extract property ID from Expedia URL: {url}")

    client = ExpediaPropertyClient(site=site, proxy_url=proxy_url)

    summary_data, details_data, gallery_data, offers_data, page_layout_data = await asyncio.gather(
        client.fetch_property_summary(property_id),
        client.fetch_property_details(property_id),
        client.fetch_product_gallery(property_id),
        client.fetch_property_offers(property_id),
        client.fetch_page_layout(property_id)
    )

    return format_property(
        summary_data=summary_data,
        content_data=details_data,
        url=url,
        property_id=property_id,
        gallery_data=gallery_data,
        offers_data=offers_data,
        page_layout_data=page_layout_data
    )


async def scrape_hotels_property(url: str, proxy_url: Optional[str] = None) -> dict:
    """Scrape a Hotels.com property."""
    from hotels_com_converter import convert_hotels_com_to_expedia

    site = expedia_detect_site(url) or "hotels.com"

    # Hotels.com uses different IDs than Expedia - need to convert
    # Extract the Expedia property ID from the Hotels.com page HTML
    expedia_id = convert_hotels_com_to_expedia(url, proxy_url)
    if not expedia_id:
        raise ValueError(f"Could not convert Hotels.com URL to Expedia property ID: {url}")

    property_id = expedia_id

    client = ExpediaPropertyClient(site=site, proxy_url=proxy_url)

    summary_data, details_data, gallery_data, offers_data, page_layout_data = await asyncio.gather(
        client.fetch_property_summary(property_id),
        client.fetch_property_details(property_id),
        client.fetch_product_gallery(property_id),
        client.fetch_property_offers(property_id),
        client.fetch_page_layout(property_id)
    )

    return format_property(
        summary_data=summary_data,
        content_data=details_data,
        url=url,
        property_id=property_id,
        gallery_data=gallery_data,
        offers_data=offers_data,
        page_layout_data=page_layout_data
    )


async def scrape_property(url: str, proxy_url: Optional[str] = None) -> dict:
    """Scrape property from VRBO, Expedia, or Hotels.com. Auto-detects platform."""
    platform = detect_platform(url)

    if platform == "vrbo":
        return await scrape_vrbo_property(url, proxy_url)
    elif platform == "expedia":
        return await scrape_expedia_property(url, proxy_url)
    elif platform == "hotels.com":
        return await scrape_hotels_property(url, proxy_url)
    else:
        raise URLParseError(f"Unsupported platform for URL: {url}")


async def main():
    """Main Actor entry point."""
    async with Actor:
        actor_input = await Actor.get_input() or {}

        urls = actor_input.get("urls", [])
        if isinstance(urls, str):
            urls = [urls]
        if not urls and actor_input.get("url"):
            urls = [actor_input["url"]]

        # Proxy configuration
        proxy_url = None
        proxy_config = actor_input.get("proxyConfiguration", {})
        if proxy_config:
            proxy_groups = proxy_config.get("groups", ["RESIDENTIAL"])
            proxy_obj = await Actor.create_proxy_configuration(groups=proxy_groups)
            if proxy_obj:
                proxy_url = await proxy_obj.new_url()

        if not urls:
            Actor.log.warning("No URLs provided in input")
            return

        Actor.log.info(f"Processing {len(urls)} URLs")

        for url in urls:
            original_url = url
            property_id = "unknown"

            try:
                # Resolve short URLs (t.vrbo.io, etc.)
                url = await resolve_short_url(url, proxy_url)
                if url != original_url:
                    Actor.log.info(f"Resolved short URL: {original_url} -> {url}")

                platform = detect_platform(url)

                # Extract property_id for error reporting
                if platform == "vrbo":
                    property_id, _ = vrbo_extract_id(url)
                else:
                    property_id, _ = extract_property_id(url)
                property_id = property_id or "unknown"

                Actor.log.info(f"Scraping {platform}: {url}")
                result = await scrape_property(url, proxy_url)
                await Actor.push_data(result)
                name = result.get('name') or f"Property {property_id}"
                Actor.log.info(f"Success: {name}")

            except URLParseError as e:
                error_result = format_error(original_url, property_id, str(e), "unknown")
                await Actor.push_data(error_result)
                Actor.log.error(f"URL parse error for {url}: {e}")

            except Exception as e:
                error_result = format_error(original_url, property_id, str(e), "unknown")
                await Actor.push_data(error_result)
                Actor.log.error(f"Failed to scrape {url}: {e}")


if __name__ == "__main__":
    asyncio.run(main())
