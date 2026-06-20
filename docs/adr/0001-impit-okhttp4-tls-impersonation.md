# Use impit's okhttp4 target for TLS impersonation

The Mobile GraphQL API blocks default HTTP-client TLS fingerprints; the Python
actor impersonates `okhttp4_android_13` via `tls_client`. For the TypeScript port
we use **impit** (the Crawlee-native Rust impersonation client) with its generic
`okhttp4` target, because it integrates with the rest of the Crawlee stack and
still presents an okhttp-family fingerprint.

## Status

proposed — gated on a pass-rate spike (≈10 signed `okhttp4` GraphQL requests
through residential, validating real property bodies) before the full port.

## Considered Options

- **node-tls-client** (Go tls-client wrapper, exact `okhttp4_android_13` match) —
  kept as the documented fallback if impit's generic `okhttp4` fingerprint is
  rejected by the endpoint. Not chosen as primary because it is not Crawlee-native.
- **got-scraping / browser impersonation** — rejected: wrong fingerprint family
  (browsers, not the mobile okhttp client the API expects).
