# Golden fixtures

`golden/*.json` are the input for `test/output.test.ts`. Each bundles, for one
Property URL:

- `graphql` — the GraphQL responses keyed by operationName,
- `prefetch` — HTML captured for that URL, keyed by absolute URL,
- `expectedRow` — the row this actor produces for it, reviewed by hand.

The test replays `graphql` through the real pipeline via a fake HttpClient, then
checks the row two ways: invariants that must hold for any Property, and equality
with `expectedRow` (ignoring the non-deterministic `scrapedAt`).

## Provenance, honestly

Captured live at the TypeScript cutover (2026-06-20) from the Python actor this
one replaces, by the throwaway `spike/capture_fixtures.py` — removed with the rest
of the Python, so see git history before the cutover commit to regenerate.

`expectedRow` began as the Python actor's output and is no longer it. The rows
were edited as the output deliberately changed: `ratingText` dropped, `host`,
`tagline` and unit prices dropped, `0` and `""` replaced with `null`, `source`
renamed to `platform`. So treat `expectedRow` as a reviewed snapshot of this
actor's own output rather than an independent oracle — the invariants are what
catch a wrong value, the equality check catches an unintended one.

Covered: Expedia (`525006`), Hotels.com (`ho136900` → Expedia `21856`), and Vrbo
(`117898910`).

## Two things that look like gaps

`TemplatePageLayout` is captured for all three Platforms even though only Vrbo
requests it now. For the others it is ~430 KB that changes nothing in the row, and
the test asserts they no longer ask for it.

Vrbo has no `prefetch`. What was captured there was the Vrbo homepage, because
`vrbo.com/<id>` redirects to it, and the pipeline does not fetch that page at all
for a bare-numeric URL. Hotels.com keeps its page — the Expedia ID is read out of
it, and the test asserts that.
