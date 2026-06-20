# Use impit's okhttp4 target for TLS impersonation

The Mobile GraphQL API blocks default HTTP-client TLS fingerprints; the Python
actor impersonates `okhttp4_android_13` via `tls_client`. For the TypeScript port
we use **impit** (the Crawlee-native Rust impersonation client) with its generic
`okhttp4` target, because it integrates with the rest of the Crawlee stack and
still presents an okhttp-family fingerprint.

## Status

**accepted** — the gate-zero spike (issue #2) passed. Holding HMAC, headers,
body and proxy constant and varying only the TLS fingerprint, 12 signed
`PropertySummary` requests through residential gave: impit `okhttp4` **11/12**
(the one miss a proxy-590 tunnel error, not a block) vs the `tls_client`
`okhttp4_android_13` baseline **12/12**; impit `chrome` was **0/12** (429). So
impit's okhttp4 target is accepted at ≈baseline. It is an okhttp-*family*
fingerprint (JA4 differs from the exact `okhttp4_android_13`), so **pin the impit
version** — an upgrade re-opens this gate — and keep the `node-tls-client`
fallback documented below. Full evidence: `spike/RESULTS.md`.

## Considered Options

- **node-tls-client** (Go tls-client wrapper, exact `okhttp4_android_13` match) —
  kept as the documented fallback if impit's generic `okhttp4` fingerprint is
  rejected by the endpoint. Not chosen as primary because it is not Crawlee-native.
- **got-scraping / browser impersonation** — rejected: wrong fingerprint family
  (browsers, not the mobile okhttp client the API expects).
