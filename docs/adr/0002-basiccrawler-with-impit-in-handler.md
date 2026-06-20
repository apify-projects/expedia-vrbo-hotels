# Build on BasicCrawler, do HTTP with impit inside the handler

Our unit of work is "one Property URL → 5 GraphQL POSTs (plus an optional HTML
prefetch for legacy-ID / Hotels.com conversion) → one Terminal row", which does
not fit Crawlee's higher-level crawlers that assume "fetch request.url → one
body". We build on **BasicCrawler** and do all HTTP with **impit inside the
requestHandler**, using Crawlee only for the request queue, concurrency, retries,
and session pool.

## Considered Options

- **HttpCrawler + ImpitHttpClient** — rejected: Crawlee would fetch the property
  page for us, but we want 5 GraphQL POSTs, not that body. We'd ignore the fetched
  response and call impit manually anyway, fighting the framework.
