# VRBO, Expedia & Hotels.com Scraper

Unified scraper for **VRBO**, **Expedia**, and **Hotels.com** property details. It
talks to the Expedia Group **Mobile GraphQL API** (impersonating the Android app)
rather than rendering web pages, and auto-detects the platform from each URL.

## Input

| Field | Type | Description |
|-------|------|-------------|
| `urls` | string[] | Property URLs from VRBO, Expedia, or Hotels.com. Platform is auto-detected. **Required.** |

```json
{
  "urls": [
    "https://www.vrbo.com/117898910",
    "https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information",
    "https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/"
  ]
}
```

The actor always runs through Apify residential proxies — the Mobile GraphQL API
rejects datacenter IPs — so there is nothing to configure. Concurrency is left to
Crawlee's autoscaling; one input URL fans out into five API calls, so a hand-set
number mostly just raises the block rate.

### Supported URL formats

- **VRBO**: numeric (`/1234567`), legacy HomeAway (`/11887139ha`), localized
  (`/en-gb/p11348801`, `/en-ca/pdp/lo/1489839`), regional sites
  (`bookabach.co.nz`, `stayz.com.au`, …), and short links (`t.vrbo.io/…`).
- **Expedia**: `…​.h12345.Hotel-Information` across international domains.
- **Hotels.com**: `…/ho12345/…` (converted to the Expedia Property ID internally).

## Output

One row per input URL — either a success row or an error row, never both. URLs
that point at the same property are scraped once; the run log says how many
duplicates were skipped. Success rows carry `platform` (`vrbo`, `expedia` or
`hotels.com`), `name`, location, `rating`,
`reviewCount`, images, amenities, policies, house rules and per-unit details.
Error rows carry `platform`, `url`, `id`, and `error`.

Prices are **not** available from this API — the offers response returns them as
`null` at every date window we tested — so the output has no price fields.

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
