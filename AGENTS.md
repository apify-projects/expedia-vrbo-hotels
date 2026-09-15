# Working on this actor

Notes a fluent Apify engineer would not guess from the code. Generic Apify and
Crawlee guidance is deliberately not repeated here.

## Shape

`main.ts` validates and de-duplicates the input URLs, then hands them to the
router in `routes.ts`, which has one handler per Platform. A handler resolves the
Property ID, calls `property-client.ts` for the GraphQL data, and pushes one item
built by `formatter.ts`. `resolvers.ts` is pure parsing - it never makes a
request.

## The API

It is the Expedia Group mobile app's GraphQL endpoint, not a public API. Two app
identities (Vrbo and Expedia) over the same schema, selected by `Profile` in
`property-client.ts`.

- Every request needs HMAC-signed headers (`auth.ts`) and a recognised TLS
  fingerprint, which is why the client is impit with `browser: 'okhttp4'`. Its
  bare default gets a flat 429; the measurements are in `spike/RESULTS.md`.
- `queries.ts` is generated from the APK and must stay byte-identical to what the
  app sends. It is excluded from Prettier and ESLint for that reason; do not
  reformat or "tidy" it.
- Vrbo is always scraped through `vrbo.com` - regional endpoints return wrong
  data for some ids. Hotels.com is scraped through the **Expedia** endpoint,
  because `hotels.com/graphql` soft-blocks through residential proxies.
- The five GraphQL calls for one Property must share one IP, so they go through
  `context.sendRequest` rather than becoming queue entries. They also total
  ~760 KB, far past what `userData` can carry between requests.
- One input URL produces exactly one dataset item. Handlers push success items;
  every error item comes from the single `failedRequestHandler` in `main.ts`.

## Which requests fetch a page

Most don't. Only these need their page, and they are the ones without
`skipNavigation`:

| URL shape                                    | why                                      |
| -------------------------------------------- | ---------------------------------------- |
| `hotels.com/ho<id>/...`                        | the page carries the Expedia Property ID |
| `vrbo.com/{locale}/p<id>`, `vrbo.com/<id>ha` | the page carries the real Property ID    |
| a short link                                 | the landing URL is the destination       |

Expedia, bare-numeric Vrbo and `/pdp/lo/<id>` already have the id in the URL.

**The Hotels.com page fetch is the least reliable hop in the actor** - roughly
23% of those URLs failed permanently when its failures were classified as "bad
URL" instead of "blocked". Letting the crawler make that request is what fixed
it. Never turn a transport or block failure there into a non-retryable error.

## Telling a dead id from a block

Both signals are deterministic, so they are non-retryable:

- a GraphQL error matching `Failed to retrieve Property|Hotel Summary`
- HTTP 200, valid JSON, and a blank `summary.name`

Neither overlaps with the block signals (empty body, non-JSON, 403, 429), which
must retry on a fresh IP. Getting this backwards was the actor's original worst
bug.

## What the API does not return

Measured across 10+ properties on both identities, so do not re-add these
expecting data:

- **Prices.** `price.lead` and `price.total` are `null` at every date window and
  request variant tried. There is no price in the output.
- **Host and tagline.** `aboutThisHost` is `null` even with
  `useNewHostSection: true`.
- **Vrbo amenities.** `amenitiesSummary` and `detailedAmenitiesContent` are
  `null` for Vrbo, so those items carry `[]`. The extractors are correct.
- **Vrbo `reviewSummary`.** Always `null`, which is why `TemplatePageLayout` is
  fetched **for Vrbo only** - it is the sole source of Vrbo's review count, and
  for the other platforms it is ~430 KB that changes nothing.

The offers query needs a lead time; it answers with an error rather than data for
dates close to today, which is why the window sits a month out.

`bestRating: "0"` means the property has no rating yet, not that it scored zero,
so the item carries `rating: null`. The review count is read separately and stays
`0` - that is the true count for an unreviewed property, not a missing value.

## Tooling worth knowing

`npm run typecheck` uses `tsconfig.check.json` so it covers `test/` too; the
build uses `tsconfig.json` and emits `src` only. `cheerio` is a dev dependency
only - at runtime `$` comes from the crawler.
