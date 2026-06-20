/**
 * Opt-in LIVE smoke test — one real URL per platform through the residential
 * proxy. Excluded from the deterministic suite (see vitest.config.ts) and gated
 * on `SMOKE=1` + `APIFY_PROXY_PASSWORD`. Run with: `npm run test:smoke`.
 *
 * This is the spiritual successor to the old `src/test_scraper.py` manual smoke
 * test — it hits the network, so it never runs in CI / the standard `npm test`.
 */
import { describe, expect,it } from 'vitest';

import { ImpitHttpClient } from '../src/http/impit-client.js';
import { type ClientKind,scrapeProperty } from '../src/pipeline.js';

const enabled = Boolean(process.env.SMOKE) && Boolean(process.env.APIFY_PROXY_PASSWORD);

const cases = [
    { platform: 'expedia', url: 'https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information' },
    { platform: 'vrbo', url: 'https://www.vrbo.com/117898910' },
    { platform: 'hotels.com', url: 'https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/' },
];

function proxyUrl(session: string): string {
    return `http://groups-RESIDENTIAL,session-${session},country-US:${process.env.APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`;
}

describe.skipIf(!enabled)('live smoke (opt-in: SMOKE=1)', () => {
    for (const c of cases) {
        it(`scrapes a real ${c.platform} property`, async () => {
            const session = `smoke${c.platform.replace(/\W/g, '')}`;
            const deps = {
                makeClient: (kind: ClientKind = 'graphql') =>
                    new ImpitHttpClient({ proxyUrl: proxyUrl(session), browser: kind === 'html' ? 'chrome' : 'okhttp4' }),
            };
            const row = await scrapeProperty(c.url, deps);
            expect(row.name?.length).toBeTruthy();
            expect(row.source).toBeTruthy();
            expect(row.id).toBeTruthy();
        }, 60_000);
    }
});
