/**
 * Opt-in LIVE smoke test — one real URL per platform through the residential
 * proxy. Gated inside the file by `describe.skipIf(!SMOKE)` so it is collected
 * but skipped in the standard suite; run with `npm run test:smoke`
 * (needs `SMOKE=1` + `APIFY_PROXY_PASSWORD`).
 *
 * Spiritual successor to the old `src/test_scraper.py` manual smoke test.
 * Retries on a fresh session/IP, mirroring what the crawler does in production,
 * so transient proxy-tunnel errors (e.g. Apify 590) don't fail a liveness check.
 */
import { describe, expect, it } from 'vitest';

import { ImpitHttpClient } from '../src/http/impit-client.js';
import { type ClientKind, scrapeProperty } from '../src/pipeline.js';

const enabled = Boolean(process.env.SMOKE) && Boolean(process.env.APIFY_PROXY_PASSWORD);

const cases = [
    { platform: 'expedia', url: 'https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information' },
    { platform: 'vrbo', url: 'https://www.vrbo.com/117898910' },
    { platform: 'hotels.com', url: 'https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/' },
];

function proxyUrl(session: string): string {
    return `http://groups-RESIDENTIAL,session-${session},country-US:${process.env.APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`;
}

/** Scrape live, rotating to a fresh session/IP on each retry (like the crawler). */
async function scrapeLive(url: string, platform: string, attempts = 3) {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        const session = `smoke${platform.replace(/\W/g, '')}${i}`;
        const deps = {
            makeClient: (kind: ClientKind = 'graphql') =>
                new ImpitHttpClient({ proxyUrl: proxyUrl(session), browser: kind === 'html' ? 'chrome' : 'okhttp4' }),
        };
        try {
            return await scrapeProperty(url, deps);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

describe.skipIf(!enabled)('live smoke (opt-in: SMOKE=1)', () => {
    for (const c of cases) {
        it(`scrapes a real ${c.platform} property`, async () => {
            const row = await scrapeLive(c.url, c.platform);
            expect(row.name?.length).toBeTruthy();
            expect(row.platform).toBeTruthy();
            expect(row.id).toBeTruthy();
        }, 120_000);
    }
});
