# Build on HttpCrawler with Crawlee's impit client

**Status: accepted** — supersedes the original BasicCrawler decision, whose stated
reason turned out to be wrong.

Scraping one Property means fetching a page whose id we need (Hotels.com, legacy
Vrbo, short links) and then five signed GraphQL POSTs. We build on
**HttpCrawler** with `httpClient: new ImpitHttpClient({ browser: 'okhttp4' })`
from `@crawlee/impit-client`:

- The page fetches are real Crawlee requests, so blocks and retries on them are
  the session pool's job. That hop was this actor's worst bug — roughly 23% of
  Hotels.com URLs failed permanently when we classified those failures ourselves.
- Requests that don't need a page (Expedia, bare-numeric Vrbo, `/pdp/lo/`) set
  `skipNavigation`.
- The five GraphQL POSTs go through `context.sendRequest`, which carries the
  request's proxy URL and session, so all of a Property's calls share one sticky
  residential IP.

## Why the GraphQL calls are not Crawlee requests

They are the documented exception ("the sub-fetch must share the parent's
session"), and turning them into five queue entries is worse: the five responses
total ~760 KB and all must be in hand before one row can be written, so that data
would have to wait in `userData` (capped near 9.5 KB — 80x too small), in the
key-value store, or in memory that a migration loses. Chaining them would also
serialise calls that are parallel today, and require a hand-rolled join. One
handler holding them in `Promise.all` is the correct shape.

## Correction to the original ADR

The first version of this decision rejected HttpCrawler because "Crawlee would
fetch the property page for us, but we want 5 GraphQL POSTs, not that body".
That was measured and found false: a page fetch IS the unit of work for two of
the three platforms, and `skipNavigation` covers the rest. CheerioCrawler remains
the wrong choice — the GraphQL responses are `application/json`, so an HTML
parser would only burn CPU. Cheerio is still used directly in `resolvers.ts`,
where there is actual HTML to read.
