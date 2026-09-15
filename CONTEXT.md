# Property Scraper

Scrapes property/hotel listing details from VRBO, Expedia, and Hotels.com by
impersonating the Expedia Group **mobile app** and calling its GraphQL API
directly (not by rendering web pages).

## Language

**Property**:
A single rental or hotel listing — the thing we scrape. One input URL identifies
exactly one Property.
_Avoid_: listing, hotel, rental (use the generic Property).

**Platform**:
Which of the three brands a URL belongs to: `vrbo`, `expedia`, or `hotels.com`.
Detected from the URL and reported as the `platform` field on every row.
_Avoid_: source, brand.

**Site**:
A regional storefront of a Platform with its own domain, site id, locale and
currency (e.g. `vrbo.com`, `bookabach.co.nz`, `stayz.com.au`). Distinct from
Platform: one Platform has many Sites.
_Avoid_: region, domain.

**Property ID**:
The internal numeric identifier the Mobile GraphQL API accepts for a Property.
The canonical key everything resolves to before fetching.

**Legacy HomeAway ID**:
An older VRBO/HomeAway identifier (e.g. `…ha` suffix, `…/p{id}` prefix, or a
localized URL) that the Mobile GraphQL API **rejects**. Must be resolved to a
Property ID before use.
_Avoid_: old id.

**Offer**:
A priced availability for a Property, returned by the offers query.
_Avoid_: price, rate, deal.

**Terminal row**:
The single dataset row a Property URL produces — either a success row or an
error row, never both and never duplicated. The core output invariant.
_Avoid_: result, record.

**Mobile GraphQL API**:
The Expedia Group mobile app's GraphQL endpoint the scraper targets by
impersonating the Android app (okhttp TLS fingerprint + HMAC-signed headers).
_Avoid_: web API, site API.
