# Agent Instructions for VRBO/Expedia/Hotels.com Scraper

## Overview

This actor scrapes property details from VRBO, Expedia, and Hotels.com using their **mobile GraphQL APIs** (not web scraping). It impersonates the Android mobile apps to avoid detection.

## Running the Actor Locally

### Input Configuration

The actor reads input from Apify's local storage:

```
storage/key_value_stores/default/INPUT.json
```

Example input:

```json
{
    "urls": [
        "https://www.vrbo.com/1234567",
        "https://www.expedia.com/Hotel.h12345.Hotel-Information",
        "https://www.hotels.com/ho12345/hotel-name/"
    ]
}
```

### Running

```bash
source .venv/bin/activate
python3 -m src.main
```

### Output

Results are saved to:

```
storage/datasets/default/*.json
```

---

## Architecture & Non-Trivial Details

### 1. TLS Fingerprinting (Anti-Bot Evasion)

The actor uses `tls_client` library with `okhttp4_android_13` fingerprint to match Android's TLS signature. This is **critical** - standard HTTP libraries like `requests` or `httpx` will be blocked.

**Key files:**

- `src/clients/vrbo_client.py` - Uses `tls_client.Session(client_identifier="okhttp4_android_13")`
- `src/hotels_com_converter.py` - Uses `curl_cffi` with `chrome120` impersonation

### 2. HMAC Authentication

All API requests require HMAC-SHA256 signed headers. Credentials were extracted from the Expedia Android app.

**File:** `src/auth.py`

```python
# Credentials from Expedia app (strings.xml)
HMAC_USERNAME = "fe627e29-3afb-4384-9fc0-a1d2a4dcd30c"
HMAC_SECRET_KEY = "S1q3f5rhAe3SCE4N"  # Deobfuscated from XOR ^ 28 + reverse
```

Headers required for every request:

- `authorization` - HMAC signature
- `x-date` - RFC 1123 timestamp
- `salt` - Random 16-char alphanumeric string

### 3. GraphQL Queries (Extracted from APK)

Queries were extracted from the VRBO Android APK via jadx decompilation. They are **very long** and specific to the mobile app's schema.

**File:** `src/queries/vrbo_queries.py`

Key queries:

- `PROPERTY_CONTENT_QUERY` - Property details, amenities, policies
- `PROPERTY_SUMMARY_QUERY` - Name, location, coordinates, reviews
- `PRODUCT_GALLERY_QUERY` - Property images
- `PROPERTY_OFFERS_QUERY` - Pricing
- `TEMPLATE_PAGE_LAYOUT_QUERY` - SEO data with rating/review count

### 4. Legacy HomeAway ID Resolution

**Critical Issue:** Legacy HomeAway URLs use a different ID system. The GraphQL API **rejects** these IDs - it only accepts internal numeric IDs.

This affects:

- URLs with `ha` suffix: `/11887139ha`
- Localized URLs without suffix: `/en-gb/p11887139` (still legacy IDs!)

**Solution:** HTML scraping to extract the internal ID from the page. Resolution is attempted for all IDs except those with `vb` suffix (native VRBO IDs).

**File:** `src/clients/vrbo_client.py` - `resolve_legacy_property_id()`

Resolution methods (in order of reliability):

1. Image URLs: `/lodging/118000000/117900000/117899000/117898910/image.jpg`
2. Meta tags: `<meta itemprop="identifier" content="117898910">`
3. JSON data: `"propertyId":"117898910"`
4. Data attributes: `data-property-id="117898910"`
5. Canonical URL patterns

Example: `11887139` or `11887139ha` → `117898910`

### 5. Short URL Resolution

Short URLs like `https://t.vrbo.io/bN81iIoI3Wb` require multi-hop redirect following:

1. `t.vrbo.io` → 307 redirect to `a8ro.app.link` (Branch.io)
2. Branch.io → 307 redirect with final VRBO URL in `Location` header

**Important:** `tls_client` returns headers with **case-sensitive keys**. Must check both `"Location"` and `"location"`.

**File:** `src/clients/vrbo_client.py` - `resolve_short_url()`

### 6. Hotels.com ID Conversion

Hotels.com uses different property IDs than Expedia. The actor must:

1. Fetch the Hotels.com page HTML
2. Extract the Expedia property ID from embedded JavaScript

**File:** `src/hotels_com_converter.py`

Extraction patterns:

- `expediaPropertyId` in JavaScript
- JSON-LD structured data
- `data-property-id` attributes

### 7. Regional Site Configurations

VRBO operates under multiple domains with different site IDs:

```python
SITE_CONFIGS = {
    "vrbo.com": {"site_id": 9001001, "tpid": 9001, "eapid": 1, "locale": "en_US", "currency": "USD"},
    "bookabach.co.nz": {"site_id": 9006043, "tpid": 9006, "eapid": 43, "locale": "en_NZ", "currency": "NZD"},
    "stayz.com.au": {"site_id": 9006044, "tpid": 9006, "eapid": 44, "locale": "en_AU", "currency": "AUD"},
    "abritel.fr": {"site_id": 9001020, "tpid": 9001, "eapid": 20, "locale": "en_US", "currency": "EUR"},
    "fewo-direkt.de": {"site_id": 9001030, "tpid": 9001, "eapid": 30, "locale": "en_US", "currency": "EUR"},
}
```

**Note:** Always use `vrbo.com` endpoint - regional endpoints can return incorrect data for some IDs.

### 8. Rating & Review Extraction

Reviews come from multiple sources with different reliability:

**Primary:** `TemplatePageLayout` → `seoStructuredData` → `aggregateRating`

```json
{
    "@type": "AggregateRating",
    "ratingValue": "9.0",
    "reviewCount": "626",
    "bestRating": "10"
}
```

**Fallback:** `PropertySummary` → `reviewSummary` → `totalCount`

**File:** `src/formatters/vrbo_formatter.py` - `extract_rating_from_page_layout()`

### 9. Retry Logic

All API calls use exponential backoff retry:

```python
@async_retry_on_error(max_retries=3, delay=2.0, backoff=2.0)
async def fetch_property_summary(...):
```

### 10. Response Validation

The actor validates that returned data matches the requested property ID (some endpoints can return wrong data):

**File:** `src/clients/vrbo_client.py` - `validate_property_response()`

---

## Supported URL Formats

### VRBO

| Format                      | Example                                               |
| --------------------------- | ----------------------------------------------------- |
| Standard numeric            | `https://www.vrbo.com/1234567`                        |
| Legacy HomeAway (ha suffix) | `https://www.vrbo.com/11887139ha`                     |
| Localized pdp/lo            | `https://www.vrbo.com/en-ca/pdp/lo/1489839`           |
| Localized with p prefix     | `https://www.vrbo.com/en-gb/p11348801`                |
| Short URLs                  | `https://t.vrbo.io/bN81iIoI3Wb`                       |
| Regional sites              | `https://www.bookabach.co.nz/holiday-homes/p497962vb` |

### Expedia

| Format        | Example                                                       |
| ------------- | ------------------------------------------------------------- |
| Standard      | `https://www.expedia.com/Hotel-Name.h12345.Hotel-Information` |
| International | `https://www.expedia.it/en/Hotel.h2692552.Hotel-Information`  |

### Hotels.com

| Format   | Example                                       |
| -------- | --------------------------------------------- |
| Standard | `https://www.hotels.com/ho136900/hotel-name/` |

---

## Key Files Reference

| File                               | Purpose                             |
| ---------------------------------- | ----------------------------------- |
| `src/main.py`                      | Actor entry point, URL routing      |
| `src/clients/vrbo_client.py`       | VRBO GraphQL client, URL resolution |
| `src/clients/expedia_client.py`    | Expedia GraphQL client              |
| `src/auth.py`                      | HMAC signing for API authentication |
| `src/queries/vrbo_queries.py`      | GraphQL queries from Android APK    |
| `src/formatters/vrbo_formatter.py` | Response data formatting            |
| `src/hotels_com_converter.py`      | Hotels.com to Expedia ID conversion |
| `src/url_parser.py`                | URL parsing and platform detection  |

---

## Testing URL Resolution

```bash
source .venv/bin/activate
python3 -c "
import asyncio
import sys
sys.path.insert(0, 'src')
from clients.vrbo_client import (
    extract_property_id_from_url,
    resolve_legacy_property_id,
    resolve_short_url,
    is_short_url
)

async def test(url):
    print(f'Input: {url}')
    if is_short_url(url):
        url = await resolve_short_url(url)
        print(f'Short URL resolved to: {url}')
    prop_id, suffix = extract_property_id_from_url(url)
    print(f'Extracted: ID={prop_id}, suffix={suffix}')
    final_id = await resolve_legacy_property_id(url, prop_id, suffix or '')
    print(f'Final ID: {final_id}')

asyncio.run(test('https://www.vrbo.com/11887139ha'))
"
```

---

## Common Issues

### 1. "Invalid PropertyId" Error

- Cause: Passing legacy HomeAway ID (with `ha` suffix) directly to API
- Fix: Use `resolve_legacy_property_id()` first

### 2. Short URL Returns Original URL

- Cause: Case-sensitive header handling in `tls_client`
- Fix: Check both `response.headers.get("Location")` and `response.headers.get("location")`

### 3. Empty Reviews/Rating

- Cause: Data not in `PropertySummary` response
- Fix: Use `TemplatePageLayout` query which contains `seoStructuredData` with `aggregateRating`

### 4. Wrong Property Data Returned

- Cause: Regional endpoints (bookabach.co.nz, etc.) return incorrect data for some IDs
- Fix: Always use `vrbo.com` endpoint regardless of input URL domain
