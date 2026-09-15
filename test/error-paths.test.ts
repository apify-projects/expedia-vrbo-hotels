/**
 * Error-path coverage (PRD testing decision: "Error-path variants assert the
 * single error row"; stories #6/#7/#9/#12). These drive the real pipeline /
 * client through the faked-impit seam and assert the THROW (so the
 * requestHandler pushes no success row, and the single error row comes from the
 * failedRequestHandler).
 */
import { describe, expect,it } from 'vitest';

import { BlockedResponseError, HotelsComDelistedError, URLParseError } from '../src/errors.js';
import { formatError } from '../src/formatter.js';
import { scrapeProperty } from '../src/pipeline.js';
import { makeExpediaProfile, PropertyClient } from '../src/property-client.js';
import { EXPEDIA_SITE_CONFIGS } from '../src/site-configs.js';
import { FakeHttp, type Route } from './fake-http.js';

// GraphQL POSTs get a summary-shaped body with the given name; GETs (legacy
// prefetch) get inert HTML.
const summaryRoute = (name: string | null): Route => (_url, init) => (init.method === 'POST'
    ? { status: 200, text: JSON.stringify({ data: { propertyInfo: { summary: { id: '1', name } } } }) }
    : { status: 200, text: '<html></html>' });

describe('error paths → pipeline throws (no success row)', () => {
    it('unsupported platform → URLParseError', async () => {
        const deps = { makeClient: () => new FakeHttp(() => ({ status: 200, text: '' })) };
        await expect(scrapeProperty('https://www.booking.com/hotel/x.html', deps)).rejects.toBeInstanceOf(URLParseError);
    });

    it('VRBO blank-name response → validation throws', async () => {
        const deps = { makeClient: () => new FakeHttp(summaryRoute('')) };
        await expect(scrapeProperty('https://www.vrbo.com/117898910', deps)).rejects.toThrow(/validation failed/i);
    });

    it('delisted Hotels.com → HotelsComDelistedError (non-retryable)', async () => {
        const deps = { makeClient: () => new FakeHttp(() => ({ status: 200, text: '<html>home</html>', url: 'https://www.hotels.com/' })) };
        await expect(scrapeProperty('https://www.hotels.com/ho136900/x/', deps)).rejects.toBeInstanceOf(HotelsComDelistedError);
    });

    it('Hotels.com page with no id → non-retryable URLParseError', async () => {
        const deps = { makeClient: () => new FakeHttp(() => ({ status: 200, text: '<html>a real page, just no ids</html>', url: 'https://www.hotels.com/ho136900/x/' })) };
        await expect(scrapeProperty('https://www.hotels.com/ho136900/x/', deps)).rejects.toBeInstanceOf(URLParseError);
    });
});

describe('Hotels.com prefetch failures are retryable, not a URL problem', () => {
    const scrape = (route: Route) => scrapeProperty(
        'https://www.hotels.com/ho118568/',
        { makeClient: () => new FakeHttp(route) },
    );

    it('403 → BlockedResponseError (retries on a fresh IP)', async () => {
        await expect(scrape(() => ({ status: 403, text: '' }))).rejects.toBeInstanceOf(BlockedResponseError);
    });

    it('429 → BlockedResponseError (retries on a fresh IP)', async () => {
        await expect(scrape(() => ({ status: 429, text: 'Too many requests' }))).rejects.toBeInstanceOf(BlockedResponseError);
    });

    it('empty 200 body → BlockedResponseError (soft-block)', async () => {
        await expect(scrape(() => ({ status: 200, text: '' }))).rejects.toBeInstanceOf(BlockedResponseError);
    });

    it('transport failure → retryable plain Error, not URLParseError', async () => {
        const p = scrape(() => { throw new Error('Request timeout (30000 ms) exceeded.'); });
        await expect(p).rejects.toThrow(/fetch failed/i);
        await expect(p).rejects.not.toBeInstanceOf(URLParseError);
    });

    it('HTTP 500 → retryable plain Error, not URLParseError', async () => {
        const p = scrape(() => ({ status: 500, text: 'oops' }));
        await expect(p).rejects.toThrow(/HTTP 500/);
        await expect(p).rejects.not.toBeInstanceOf(URLParseError);
    });
});

describe('block detection → BlockedResponseError (retire session, rotate IP — story #12)', () => {
    const client = (http: FakeHttp) => new PropertyClient({
        profile: makeExpediaProfile(EXPEDIA_SITE_CONFIGS['expedia.com']),
        site: EXPEDIA_SITE_CONFIGS['expedia.com'],
        http,
    });

    it('HTTP 429 → BlockedResponseError', async () => {
        await expect(client(new FakeHttp(() => ({ status: 429, text: '' }))).fetchPropertySummary('525006'))
            .rejects.toBeInstanceOf(BlockedResponseError);
    });

    it('HTTP 403 → BlockedResponseError', async () => {
        await expect(client(new FakeHttp(() => ({ status: 403, text: '' }))).fetchPropertySummary('525006'))
            .rejects.toBeInstanceOf(BlockedResponseError);
    });

    it('empty body → BlockedResponseError', async () => {
        await expect(client(new FakeHttp(() => ({ status: 200, text: '' }))).fetchPropertySummary('525006'))
            .rejects.toBeInstanceOf(BlockedResponseError);
    });
});

describe('formatError → one structured error row (story #7)', () => {
    it('carries source, url, id, error + a scrapedAt timestamp', () => {
        const row = formatError('https://www.vrbo.com/x', '123', 'boom', 'unknown');
        expect(row).toMatchObject({ source: 'unknown', url: 'https://www.vrbo.com/x', id: '123', error: 'boom' });
        expect(typeof row.scrapedAt).toBe('string');
        expect(Object.keys(row).sort()).toEqual(['error', 'id', 'scrapedAt', 'source', 'url']);
    });
});
