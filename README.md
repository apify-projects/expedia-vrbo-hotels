# VRBO, Expedia & Hotels.com Scraper

Unified scraper for **VRBO**, **Expedia**, and **Hotels.com** property details. It
talks to the Expedia Group **Mobile GraphQL API** (impersonating the Android app)
rather than rendering web pages, and auto-detects the platform from each URL.

## Input

| Field | Type | Description |
|-------|------|-------------|
| `urls` | string[] | Property URLs from VRBO, Expedia, or Hotels.com. Platform is auto-detected. **Required.** |
| `maxConcurrency` | integer | How many URLs to scrape in parallel (default `10`). |
| `proxyConfiguration` | object | Proxy settings. **Residential is the default and is required in practice** — the API blocks datacenter IPs. |

```json
{
  "urls": [
    "https://www.vrbo.com/117898910",
    "https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information",
    "https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/"
  ],
  "maxConcurrency": 10,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

### Supported URL formats

- **VRBO**: numeric (`/1234567`), legacy HomeAway (`/11887139ha`), localized
  (`/en-gb/p11348801`, `/en-ca/pdp/lo/1489839`), regional sites
  (`bookabach.co.nz`, `stayz.com.au`, …), and short links (`t.vrbo.io/…`).
- **Expedia**: `…​.h12345.Hotel-Information` across international domains.
- **Hotels.com**: `…/ho12345/…` (converted to the Expedia Property ID internally).

## Output

One **Terminal row per input URL** — either a success row or an error row, never
both, never duplicated. Success rows carry `source`, `name`, location, `rating`,
`reviewCount`, images, amenities, policies, host, house rules, per-unit details,
pricing, and more. Error rows carry `source`, `url`, `id`, and `error`.

## How it works

- **HTTP**: [impit](https://github.com/apify/impit) impersonating the `okhttp4`
  Android TLS fingerprint (validated against the live endpoint before the build).
- **Concurrency, retries, resume**: [Crawlee](https://crawlee.dev)'s
  `BasicCrawler` — one sticky residential IP per URL; an aborted/migrated run
  resumes and skips already-scraped properties.
- **Per property**: ID resolution → 5 parallel GraphQL fetches → response
  validation → output formatting.

## Notes

- A soft-blocked (empty-body) response automatically rotates to a fresh IP and
  retries.
- Non-retryable inputs (unsupported URL, delisted Hotels.com listing) fail fast
  with a structured error row.
