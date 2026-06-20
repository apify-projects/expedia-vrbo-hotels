# Crawlee RequestQueue owns resume, error rows, and concurrency

The Python actor hand-rolled resume via a `PROCESSED_URLS` key-value entry and a
`PERSIST_STATE` event listener — which crashed at runtime ("There is no current
event loop in thread") because the listener scheduled a coroutine from a worker
thread. The TypeScript port deletes all of that and leans on Crawlee instead:

- **Resume** = Crawlee RequestQueue persists handled requests across
  abort/migration and dedups by URL; resurrected runs skip done Properties for free.
- **Terminal-row invariant** = the requestHandler pushes success rows only; all
  error rows come from a single `failedRequestHandler`. One handled request = one row.
- **Concurrency** = AutoscaledPool runs URLs in parallel up to a configurable max,
  with one sticky residential session (IP) per URL via the SessionPool; a blocked
  (empty-body) response retires the session so the retry lands a fresh IP.

## Consequences

Removes the manual state code and the crashing listener entirely. The output
invariant is now enforced structurally by the queue rather than by a manual
`processed` set saved after each URL.
