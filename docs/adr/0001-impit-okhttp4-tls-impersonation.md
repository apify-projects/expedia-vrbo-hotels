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
impit's okhttp4 target is accepted at ≈baseline. It is an okhttp-_family_
fingerprint (JA4 differs from the exact `okhttp4_android_13`), so **pin the impit
version** — an upgrade re-opens this gate — and keep the `node-tls-client`
fallback documented below. Full evidence: `spike/RESULTS.md`.

## Re-check (2026-09-14): the headline claim no longer reproduces

Six signed `PropertySummary` requests per fingerprint, against both endpoints
from a single IP:

| fingerprint                  | expedia.com/graphql | vrbo.com/graphql |
| ---------------------------- | ------------------- | ---------------- |
| `okhttp4`                    | 6/6                 | 6/6              |
| `chrome`                     | 6/6                 | 6/6              |
| `firefox`                    | 6/6                 | 6/6              |
| impit default (no `browser`) | 0/6, all 429        | 0/6, all 429     |

So the binding constraint looks like "present _a_ recognised TLS fingerprint",
not "present okhttp4 specifically" — impit's bare default is what gets blocked.

This is one IP at one moment, against the spike's twelve fresh residential IPs,
so it does not overturn the spike: the chrome 429s there may have been IP
reputation. But since the exact `impit` pin and the residential-only requirement
both rest on the original claim, re-run the spike's 12-IP method before hardening
anything else on it. `okhttp4` stays the configured target either way.

## Considered Options

- **node-tls-client** (Go tls-client wrapper, exact `okhttp4_android_13` match) —
  kept as the documented fallback if impit's generic `okhttp4` fingerprint is
  rejected by the endpoint. Not chosen as primary because it is not Crawlee-native.
- **got-scraping / browser impersonation** — rejected: wrong fingerprint family
  (browsers, not the mobile okhttp client the API expects).
