#!/usr/bin/env python3
"""
Unified Property Scraper for VRBO, Expedia, and Hotels.com.

Scrapes property details from any of the three platforms,
auto-detecting the platform from the URL.
"""

import asyncio
import os
import re
import socket
import sys
from typing import Optional
from urllib.parse import urlparse

import httpx

from apify import Actor

# Add src to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from url_parser import extract_property_id, URLParseError, detect_platform
from clients.vrbo_client import (
    VrboPropertyClient,
    detect_site_from_url as vrbo_detect_site,
    extract_property_id_from_url as vrbo_extract_id,
    resolve_legacy_property_id,
)
from clients.expedia_client import ExpediaPropertyClient, detect_site_from_url as expedia_detect_site
from formatters.vrbo_formatter import format_property, format_error


# Short URL domains that need resolution
SHORT_URL_DOMAINS = {"t.vrbo.io", "vrbo.io", "t.expedia.com", "t.hotels.com"}

# Branch.io deep link domains (require DNS bypass)
DEEP_LINK_DOMAINS = {"expe.app.link", "hotels.app.link"}


async def resolve_via_google_dns(domain: str) -> str:
    """Resolve domain to IP via Google DNS to bypass local DNS blocking.

    Branch.io app.link domains may be blocked at the DNS level in some
    environments. Using Google's public DNS resolver bypasses this.
    """
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(
            "https://dns.google/resolve",
            params={"name": domain, "type": "A"}
        )
        data = resp.json()
        if "Answer" in data:
            return data["Answer"][0]["data"]
        raise Exception(f"Could not resolve {domain} via Google DNS")


def expand_deep_link_sync(short_url: str, ip: str, domain: str) -> str:
    """Synchronous helper to expand deep link with socket patching.

    Uses requests library which respects socket.getaddrinfo patching.
    httpx/asyncio use different DNS resolution that bypasses socket patching.
    """
    import requests as sync_requests
    from urllib.parse import unquote

    _original_getaddrinfo = socket.getaddrinfo

    def _patched_getaddrinfo(host, port, family=0, type_=0, proto=0, flags=0):
        if host == domain:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, port if port else 443))]
        return _original_getaddrinfo(host, port, family, type_, proto, flags)

    socket.getaddrinfo = _patched_getaddrinfo
    try:
        resp = sync_requests.get(
            short_url,
            allow_redirects=False,  # Don't follow redirects - check Location header first
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )

        # Check for HTTP redirect first (like VRBO does)
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location") or resp.headers.get("location", "")
            if location and ("expedia" in location or "hotels.com" in location):
                return location

        # Fall back to parsing HTML for browser_fallback_url (same as VRBO)
        html = resp.text
        match = re.search(r'browser_fallback_url=([^&"\'>\s]+)', html)
        if match:
            fallback_url = unquote(match.group(1))
            if "expedia" in fallback_url or "hotels.com" in fallback_url:
                return fallback_url

        # If no match found, return original URL
        return short_url
    finally:
        socket.getaddrinfo = _original_getaddrinfo


async def expand_deep_link(short_url: str) -> str:
    """Expand Branch.io deep links (expe.app.link, hotels.app.link) using Google DNS.

    These deep links redirect to Expedia/Hotels.com property URLs. We use Google DNS
    to resolve the IP address and patch socket.getaddrinfo to bypass potential
    local DNS blocking.
    """
    parsed = urlparse(short_url)
    domain = parsed.netloc

    # Resolve IP via Google DNS
    ip = await resolve_via_google_dns(domain)

    # Run synchronous request in thread pool (requests respects socket patching, httpx doesn't)
    return await asyncio.to_thread(expand_deep_link_sync, short_url, ip, domain)


async def resolve_short_url(url: str, proxy_url: Optional[str] = None) -> str:
    """
    Resolve short URLs (t.vrbo.io, etc.) and deep links to their final destination.

    Short URLs use JavaScript redirects, so we need to parse the HTML.
    Deep links (expe.app.link, hotels.app.link) require DNS bypass via Google DNS.
    """
    parsed = urlparse(url)

    # Handle Branch.io deep links (require DNS bypass)
    if parsed.netloc in DEEP_LINK_DOMAINS:
        return await expand_deep_link(url)

    # Handle standard short URLs
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
    # Always use vrbo.com endpoint - regional endpoints (bookabach.co.nz, etc.)
    # can return wrong property data for certain IDs
    site = "vrbo.com"
    property_id, suffix = vrbo_extract_id(url)
    if not property_id:
        raise ValueError(f"Could not extract property ID from VRBO URL: {url}")

    # Resolve legacy HomeAway IDs (with 'ha' suffix) to internal VRBO IDs
    # These use a different ID system that requires HTML page lookup
    resolved_id = await resolve_legacy_property_id(url, property_id, suffix, proxy_url)
    if resolved_id != property_id:
        Actor.log.info(f"Resolved legacy HomeAway ID: {property_id}{suffix} -> {resolved_id}")

    client = VrboPropertyClient(site=site, proxy_url=proxy_url)

    # Fetch all required data in parallel using resolved ID
    summary_data, details_data, gallery_data, offers_data, page_layout_data = await asyncio.gather(
        client.fetch_property_summary(resolved_id),
        client.fetch_property_details(resolved_id),
        client.fetch_product_gallery(resolved_id),
        client.fetch_property_offers(resolved_id),
        client.fetch_page_layout(resolved_id)
    )

    return format_property(
        summary_data=summary_data,
        content_data=details_data,
        url=url,
        property_id=resolved_id,
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

    # Hotels.com uses different IDs than Expedia - need to convert
    # Extract the Expedia property ID from the Hotels.com page HTML
    expedia_id = convert_hotels_com_to_expedia(url, proxy_url)
    if not expedia_id:
        raise ValueError(f"Could not convert Hotels.com URL to Expedia property ID: {url}")

    property_id = expedia_id

    # Scrape via the Expedia GraphQL endpoint rather than www.hotels.com/graphql:
    # the hotels.com endpoint gets blocked (empty body) through residential proxies,
    # while expedia.com serves the same Expedia Group backend and works reliably.
    # The output platform/source stays "hotels.com" since it derives from `url`.
    client = ExpediaPropertyClient(site="expedia.com", proxy_url=proxy_url)

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

        max_retries = actor_input.get("maxRetries", 3)

        for url in urls:
            original_url = url
            property_id = "unknown"
            last_error = None

            for attempt in range(max_retries):
                try:
                    # Resolve short URLs (t.vrbo.io, etc.) - only on first attempt
                    if attempt == 0:
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

                    Actor.log.info(f"Scraping {platform}: {url}" + (f" (attempt {attempt + 1}/{max_retries})" if attempt > 0 else ""))
                    result = await scrape_property(url, proxy_url)
                    await Actor.push_data(result)
                    name = result.get('name') or f"Property {property_id}"
                    Actor.log.info(f"Success: {name}")
                    break  # Success, exit retry loop

                except URLParseError as e:
                    # URL parse errors are not retryable
                    error_result = format_error(original_url, property_id, str(e), "unknown")
                    await Actor.push_data(error_result)
                    Actor.log.error(f"URL parse error for {url}: {e}")
                    break

                except Exception as e:
                    last_error = e
                    if attempt < max_retries - 1:
                        delay = (2 ** attempt) + 1  # Exponential backoff: 2s, 3s, 5s
                        Actor.log.warning(f"Attempt {attempt + 1}/{max_retries} failed for {url}: {e}. Retrying in {delay}s...")
                        await asyncio.sleep(delay)
                    else:
                        # Final attempt failed
                        error_result = format_error(original_url, property_id, str(e), "unknown")
                        await Actor.push_data(error_result)
                        Actor.log.error(f"Failed to scrape {url} after {max_retries} attempts: {e}")


if __name__ == "__main__":
    asyncio.run(main())
