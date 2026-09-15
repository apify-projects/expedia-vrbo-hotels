/**
 * Opt-in LIVE smoke test — one real URL per platform through the residential
 * proxy. Gated inside the file by `describe.skipIf(!SMOKE)` so it is collected
 * but skipped in the standard suite; run with `npm run test:smoke`
 * (needs `SMOKE=1` + `APIFY_PROXY_PASSWORD`).
 *
 * Retries on a fresh session/IP, mirroring what the crawler does in production,
 * so transient proxy-tunnel errors (e.g. Apify 590) don't fail a liveness check.
 */
import { ImpitHttpClient } from '@crawlee/impit-client';
import { describe, expect, it } from 'vitest';

import type { SendRequest } from '../src/property-client.js';
import { scrapeProperty } from '../src/routes.js';
import type { Platform } from '../src/url-parser.js';

const enabled = Boolean(process.env.SMOKE) && Boolean(process.env.APIFY_PROXY_PASSWORD);

const cases: { platform: Platform; propertyId: string; url: string }[] = [
    {
        platform: 'expedia',
        propertyId: '525006',
        url: 'https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information',
    },
    { platform: 'vrbo', propertyId: '117898910', url: 'https://www.vrbo.com/117898910' },
    {
        platform: 'hotels.com',
        propertyId: '21856',
        url: 'https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/',
    },
];

const client = new ImpitHttpClient({ browser: 'okhttp4', ignoreTlsErrors: true });

/**
 * Stand in for the crawler's sendRequest, pinned to one proxy session. Crawlee
 * 3.x still types `sendRequest` with the legacy got shape (its own source calls
 * that "outright wrong"), so the impit client's response needs a cast here.
 */
function sendVia(session: string): SendRequest {
    const proxyUrl = `http://groups-RESIDENTIAL,session-${session},country-US:${process.env.APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`;
    const send = async (options: { url?: string } & Record<string, unknown> = {}) =>
        client.sendRequest({
            responseType: 'text',
            ...options,
            url: options.url ?? '',
            proxyUrl,
        });
    return send as unknown as SendRequest;
}

/** Scrape live, rotating to a fresh session/IP on each retry (like the crawler). */
async function scrapeLive(platform: Platform, propertyId: string, url: string, attempts = 3) {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const session = `smoke${platform.replace(/\W/g, '')}${attempt}`;
        try {
            return await scrapeProperty({ url, platform, propertyId, sendRequest: sendVia(session) });
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

describe.skipIf(!enabled)('live smoke (opt-in: SMOKE=1)', () => {
    for (const testCase of cases) {
        it(`scrapes a real ${testCase.platform} property`, async () => {
            const row = await scrapeLive(testCase.platform, testCase.propertyId, testCase.url);
            expect(row.name?.length).toBeTruthy();
            expect(row.platform).toBe(testCase.platform);
            expect(row.id).toBe(testCase.propertyId);
        }, 120_000);
    }
});
