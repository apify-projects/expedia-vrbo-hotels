# Gate-zero spike results (issue #2)

**Decision: GO — proceed with `impit` (`okhttp4` target). `node-tls-client` stays the documented fallback.**

Date: 2026-06-20. Throwaway spike; not merged into the actor.

## Method

Held HMAC (`src/auth.py`), the `PropertySummary` GraphQL query, headers, the
request body, the proxy (Apify **residential**, `country-US`, fresh session →
fresh exit IP per request), and the property ID **constant**. Varied **only the
HTTP client / TLS fingerprint**. A fresh residential IP per request isolates the
fingerprint from any single-IP reputation effect.

"pass" = HTTP 200 **and** a non-empty body with a real Property name
(`data.propertyInfo.summary.name`). The endpoint soft-blocks with empty/non-JSON
bodies, so HTTP 200 alone is not a pass.

Confirmed-good property ID set after baseline discovery: `["525006"]` (live name
"Hotel PULSE8"). Other candidate IDs returned `200` with no `summary.name` (not
real properties) and were excluded. The variety axis exercised was **IP**
(12 fresh residential IPs), not ID — correct for a fingerprint-acceptance gate.

## Pass-rate (12 signed requests each, same IDs, same proxy)

| client       | config                          | pass-rate        | notes                                                                                                                           |
| ------------ | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tls_client` | `okhttp4_android_13` (baseline) | **12/12 = 100%** | —                                                                                                                               |
| `impit`      | `browser="okhttp4"`             | **11/12 = 92%**  | the 1 miss was a proxy CONNECT-590 tunnel error, **not** an endpoint block → 11/11 = 100% of requests that reached the endpoint |
| `impit`      | `browser="chrome"`              | 0/12 = 0%        | every request HTTP **429** (chrome fingerprint actively blocked)                                                                |

## TLS fingerprint characterization (JA3/JA4 via tls.peet.ws, through the proxy)

| client                          | JA4                                    | JA3 hash    | #ciphers |
| ------------------------------- | -------------------------------------- | ----------- | -------- |
| `tls_client okhttp4_android_13` | `t13d1513h2_8daaf6152771_40271e0a5736` | `d296bf28…` | 15       |
| `impit okhttp4`                 | `t13d912h2_f91f431d341e_81b7ed51cef9`  | `d9c220b9…` | 9        |
| `impit chrome`                  | `t13d1516h2_8daaf6152771_afc95f72a295` | `973bedd2…` | 16       |
| `impit firefox`                 | `t13d1715h2_5b57614c22b0_80badc04439d` | `f657dcf5…` | 17       |
| `impit default` (no browser)    | `t13d1012_61a7ad8aa9b6_7d269c6e5ebc`   | `ab94e382…` | 10       |

## Interpretation (honest)

- The Python type stub advertises `Browser = Literal['chrome','firefox']`, but
  `browser="okhttp4"` produces a **distinct fingerprint** (JA4 `t13d912h2…`,
  9 ciphers) that is **neither impit's default** (`t13d1012`, 10 ciphers) **nor
  chrome/firefox**. So the value is **honored**, not silently ignored — impit's
  underlying Rust engine recognizes an okhttp-family target beyond what the stub
  lists.
- It is **not byte-exact** to the real `okhttp4_android_13` (15 ciphers,
  `t13d1513h2…`). It's an okhttp-family **approximation**. The gate measures
  _acceptance_, not byte-equality, and the endpoint accepts it at ≈baseline.
- The contrast is the proof: same HMAC/body/IPs, impit **chrome → 100% blocked
  (429)**, impit **okhttp4 → ~100% accepted**. The TLS fingerprint is the
  deciding variable, and impit's okhttp4 target clears the bar.

## Consequences for the port (ADR-0001)

- **Use impit with `browser: "okhttp4"`.** Do **not** use `chrome`/`firefox`/
  default — only the okhttp4 target is accepted.
- **Pin the impit version.** Acceptance rides on impit's okhttp4 fingerprint;
  treat an impit upgrade as a change that re-opens this gate.
- **Keep `node-tls-client` (exact `okhttp4_android_13`) as the documented
  fallback** if a future impit changes the okhttp4 fingerprint and the endpoint
  starts soft-blocking.
- Treat empty-body / non-JSON / 429 responses as **blocks** → retire the session
  so the retry lands a fresh IP (this is already the planned SessionPool behavior).
