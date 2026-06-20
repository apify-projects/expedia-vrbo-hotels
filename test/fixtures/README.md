# Golden fixtures (parity gate)

`golden/*.json` are the ground truth for `test/parity.test.ts`. Each bundles, for
one Property URL:

- `graphql` — the 5 GraphQL responses keyed by operationName,
- `prefetch` — any HTML the pipeline fetches (legacy-id resolution / Hotels.com
  conversion), keyed by absolute URL,
- `expectedRow` — the Terminal row the **Python actor** produced for that URL.

The parity test replays `graphql` + `prefetch` through the real TS pipeline via a
fake HttpClient and asserts the produced row equals `expectedRow` (ignoring the
non-deterministic `scrapedAt`). Passing ⇒ the TS port is output-equivalent to the
Python actor on real data.

Captured live from the Python actor at the ts-rewrite cutover (2026-06-20) by the
throwaway `spike/capture_fixtures.py` (removed with the rest of the Python at
cutover; see git history before the cutover commit to regenerate). Covered:
Expedia (`525006`), VRBO (`117898910`, with legacy-id HTML prefetch), and
Hotels.com (`ho136900` → Expedia `21856`, with conversion HTML prefetch).
