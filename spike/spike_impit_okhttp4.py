#!/usr/bin/env python3
"""
Gate-zero spike (issue #2): does impit's fingerprint get accepted by the
Expedia Group Mobile GraphQL API the way tls_client's `okhttp4_android_13` does?

THROWAWAY. Not part of the actor. Reuses the actor's real HMAC signer
(`src/auth.py`) and one real GraphQL query (`PropertySummary`), holding the
HMAC, headers, GraphQL body and proxy constant. The ONLY variable is the HTTP
client / TLS fingerprint:

  - tls_okhttp4   : tls_client, client_identifier="okhttp4_android_13"  (BASELINE)
  - impit_okhttp4 : impit, browser="okhttp4"  (ADR-0001's proposed target)
  - impit_chrome  : impit, browser="chrome"   (impit's only real impersonation)

"pass" = HTTP 200 AND a non-empty body containing a real Property name
(data.propertyInfo.summary.name). The endpoint soft-blocks with empty/non-JSON
bodies, so HTTP 200 alone is not a pass.

Run:
    APIFY_PROXY_PASSWORD=... .venv/bin/python spike/spike_impit_okhttp4.py
"""

import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Reuse the actor's real HMAC signer + real query, unchanged.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from auth import get_signed_headers  # noqa: E402
from queries.vrbo_queries import PROPERTY_SUMMARY_QUERY  # noqa: E402

import tls_client  # noqa: E402
import impit  # noqa: E402


# --- Constants held identical across every backend -------------------------

GRAPHQL_URL = "https://www.expedia.com/graphql"
GRAPHQL_PATH = "/graphql"

# expedia.com site config (copied constant from src/clients/expedia_client.py)
SITE = {
    "site_id": 1, "tpid": 1, "eapid": 0, "locale": "en_US", "currency": "USD",
    "app_name": "android.com.expedia.bookings", "app_version": "2024.47.0",
}

# Candidate Expedia property IDs. The baseline run filters these down to the
# ones that actually return a real Property body; every backend is then tested
# against that same confirmed-good set.
CANDIDATE_IDS = ["525006", "8615296", "1383920", "9379254", "451751"]

N_REQUESTS = 12          # >= 10 signed requests per backend (issue #2 criterion)
REQUEST_TIMEOUT = 30.0
POLITE_DELAY_S = 0.6


def proxy_url(session_id: str) -> str:
    """Apify residential proxy; a fresh session id == a fresh exit IP."""
    pw = os.environ["APIFY_PROXY_PASSWORD"]
    return (
        f"http://groups-RESIDENTIAL,session-{session_id},country-US:"
        f"{pw}@proxy.apify.com:8000"
    )


def build_context(device_id: str) -> dict:
    return {
        "clientInfo": {"name": SITE["app_name"], "version": SITE["app_version"]},
        "currency": SITE["currency"], "locale": SITE["locale"],
        "siteId": SITE["site_id"], "tpid": SITE["tpid"], "eapid": SITE["eapid"],
        "device": {"type": "APP_TABLET"},
        "identity": {"authState": "ANONYMOUS", "duaid": device_id, "tuid": "-1"},
        "privacyTrackingState": "CAN_TRACK",
        "debugContext": {"abacusOverrides": []},
    }


def build_payload(property_id: str, device_id: str) -> dict:
    return {
        "operationName": "PropertySummary",
        "variables": {
            "context": build_context(device_id),
            "propertyId": property_id,
            "searchCriteria": {
                "primary": {
                    "destination": {"mapBounds": [], "regionName": ""},
                    "rooms": [{"adults": 2, "children": []}],
                },
                "secondary": {
                    "booleans": [], "dates": [], "ranges": [],
                    "selections": [
                        {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
                        {"id": "productOffersId", "value": str(uuid.uuid4())},
                    ],
                },
            },
        },
        "query": PROPERTY_SUMMARY_QUERY,
    }


def build_headers(device_id: str) -> dict:
    signed = get_signed_headers("POST", GRAPHQL_PATH, None)
    locale, app_name, app_version = SITE["locale"], SITE["app_name"], SITE["app_version"]
    return {
        "accept": "multipart/mixed;deferSpec=20220824, application/graphql-response+json, application/json",
        "content-type": "application/json",
        "user-agent": f"Expedia/{app_version} Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)",
        "client-info": f"{app_name},{app_version},external",
        "device-user-agent-id": device_id,
        "x-eb-client": (
            f"PLATFORM:ANDROID;OS_VERSION:13;MANUFACTURER:unknown;MODEL:Generic Android-x86_64;"
            f"MODEL_NAME:Generic Android-x86_64;UPGRADE:false;APP_VERSION:{app_version};"
            f"LOCALE:{locale};APP_IDENTIFIER:{app_name.replace('android.', '')};"
        ),
        "x-apollo-operation-name": "PropertySummary",
        "x-apollo-operation-id": "PropertySummary",
        "x-mobvisid": str(uuid.uuid4()),
        "ctx-view-id": str(uuid.uuid4()),
        **signed,
    }


def classify(status: int, text: str) -> tuple[bool, str]:
    """(passed, note). pass == HTTP 200 + real Property name in body."""
    body = (text or "").strip()
    if status != 200:
        return False, f"HTTP {status}"
    if not body:
        return False, "empty body (soft-block)"
    try:
        data = json.loads(body)
    except ValueError:
        return False, f"non-JSON body ({len(body)}B): {body[:60]!r}"
    if data.get("errors"):
        msgs = "; ".join(e.get("message", "?") for e in data["errors"])
        return False, f"graphql errors: {msgs[:80]}"
    name = (((data.get("data") or {}).get("propertyInfo") or {}).get("summary") or {}).get("name")
    if name:
        return True, f"name={name!r}"
    return False, "200 but no summary.name"


# --- Backends: identical request, different TLS fingerprint ----------------

def fire_tls_client(property_id: str, session_id: str) -> tuple[int, str]:
    device_id = str(uuid.uuid4())
    s = tls_client.Session(client_identifier="okhttp4_android_13", random_tls_extension_order=True)
    p = proxy_url(session_id)
    s.proxies = {"http": p, "https": p}
    body = json.dumps(build_payload(property_id, device_id))
    r = s.post(GRAPHQL_URL, data=body, headers=build_headers(device_id))
    return r.status_code, (r.text or "")


def make_impit_backend(browser: str):
    def fire(property_id: str, session_id: str) -> tuple[int, str]:
        device_id = str(uuid.uuid4())
        c = impit.Client(
            browser=browser, proxy=proxy_url(session_id),
            timeout=REQUEST_TIMEOUT, verify=False,
        )
        body = json.dumps(build_payload(property_id, device_id))
        r = c.post(GRAPHQL_URL, content=body.encode("utf-8"), headers=build_headers(device_id))
        return r.status_code, (r.text or "")
    return fire


BACKENDS = {
    "tls_okhttp4": fire_tls_client,
    "impit_okhttp4": make_impit_backend("okhttp4"),
    "impit_chrome": make_impit_backend("chrome"),
}


def discover_good_ids() -> list[str]:
    """Confirm which candidate IDs return a real body, using the baseline client."""
    good = []
    print(f"\n[discover] probing {len(CANDIDATE_IDS)} candidate IDs via tls_client baseline...")
    for i, pid in enumerate(CANDIDATE_IDS):
        try:
            status, text = fire_tls_client(pid, f"disc{i}")
            ok, note = classify(status, text)
        except Exception as e:
            ok, note = False, f"EXC {type(e).__name__}: {str(e)[:80]}"
        print(f"  id={pid:>9}  {'GOOD' if ok else 'skip'}  {note}")
        if ok:
            good.append(pid)
        time.sleep(POLITE_DELAY_S)
    return good


def run_backend(name: str, fire, ids: list[str]) -> dict:
    print(f"\n[{name}] firing {N_REQUESTS} signed requests (fresh IP each)...")
    passed = 0
    rows = []
    for i in range(N_REQUESTS):
        pid = ids[i % len(ids)]
        sid = f"{name}{i}"
        t0 = time.time()
        try:
            status, text = fire(pid, sid)
            ok, note = classify(status, text)
        except Exception as e:
            ok, note = False, f"EXC {type(e).__name__}: {str(e)[:90]}"
        dt = time.time() - t0
        passed += ok
        rows.append((pid, ok, note))
        print(f"  [{i+1:>2}/{N_REQUESTS}] id={pid:>9} {'PASS' if ok else 'FAIL'} ({dt:4.1f}s) {note}")
        time.sleep(POLITE_DELAY_S)
    rate = passed / N_REQUESTS
    print(f"[{name}] pass-rate = {passed}/{N_REQUESTS} = {rate:.0%}")
    return {"name": name, "passed": passed, "total": N_REQUESTS, "rate": rate, "rows": rows}


def main() -> None:
    if "APIFY_PROXY_PASSWORD" not in os.environ:
        sys.exit("APIFY_PROXY_PASSWORD not set")

    started = datetime.now(timezone.utc).isoformat()
    good = discover_good_ids()
    if not good:
        sys.exit("No candidate IDs returned a real body via baseline; cannot run spike.")
    print(f"\n[discover] confirmed-good IDs: {good}")

    results = [run_backend(name, fire, good) for name, fire in BACKENDS.items()]

    print("\n" + "=" * 60)
    print("GATE-ZERO SPIKE RESULTS")
    print("=" * 60)
    for r in results:
        print(f"  {r['name']:<16} {r['passed']:>2}/{r['total']}  {r['rate']:.0%}")

    baseline = next(r for r in results if r["name"] == "tls_okhttp4")
    impit_ok = next(r for r in results if r["name"] == "impit_okhttp4")

    # GO if impit reaches ~the baseline rate (within 20 pts) and is usable (>=50%).
    go = impit_ok["rate"] >= max(0.5, baseline["rate"] - 0.2)
    decision = "impit (PROCEED)" if go else "node-tls-client (FALLBACK)"
    print("\nDECISION:", decision)
    print(f"  baseline tls_client okhttp4_android_13: {baseline['rate']:.0%}")
    print(f"  impit okhttp4:                          {impit_ok['rate']:.0%}")

    report = {
        "started": started,
        "finished": datetime.now(timezone.utc).isoformat(),
        "good_ids": good,
        "n_requests": N_REQUESTS,
        "results": [{k: r[k] for k in ("name", "passed", "total", "rate")} for r in results],
        "decision": decision,
        "go_impit": go,
    }
    out = Path(__file__).resolve().parent / "results.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
