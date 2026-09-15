# Crawlee RequestQueue owns resume, error rows, and concurrency

The Python actor hand-rolled resume via a `PROCESSED_URLS` key-value entry and a
`PERSIST_STATE` event listener — which crashed at runtime ("There is no current
event loop in thread") because the listener scheduled a coroutine from a worker
thread. The TypeScript port deletes all of that and leans on Crawlee instead:

- **Resume** = Crawlee RequestQueue persists handled requests across
  abort/migration and dedups by URL; resurrected runs skip done Properties for free.
- **One-row invariant** = the platform routes push success rows only; all error
  rows come from a single `failedRequestHandler`. A short link is the one input
  that becomes two requests — it resolves, then re-enqueues its destination — and
  only the second one writes a row.
- **Concurrency** = AutoscaledPool decides it; there is no input for it, because
  one URL fans out into several API calls and a hand-set number mostly raises the
  block rate. One sticky residential session (IP) per request via the SessionPool;
  a blocked response retires the session so the retry lands a fresh IP.

## Consequences

Removes the manual state code and the crashing listener entirely. The output
invariant is now enforced structurally by the queue rather than by a manual
`processed` set saved after each URL.
