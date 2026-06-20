import { describe, expect,it } from 'vitest';

import { HotelsComDelistedError } from '../src/errors.js';
import {
    convertHotelsComToExpedia,
    extractExpediaIdFromUrl,
    isResolvableUrl,
    resolveLegacyPropertyId,
    resolveShortUrl,
} from '../src/resolvers.js';
import { FakeHttp } from './fake-http.js';

describe('resolveLegacyPropertyId', () => {
    it("skips the fetch and returns the id for 'vb' (native VRBO) suffix", async () => {
        const http = new FakeHttp(() => { throw new Error('should not fetch'); });
        expect(await resolveLegacyPropertyId('https://www.vrbo.com/497962vb', '497962', 'vb', http)).toBe('497962');
        expect(http.calls).toHaveLength(0);
    });

    it('resolves the internal id from the og:image lodging path', async () => {
        const html = '<img src="https://media.vrbo.com/lodging/118000000/117900000/117899000/117898910/abc.jpg">';
        const http = new FakeHttp(() => ({ text: html }));
        expect(await resolveLegacyPropertyId('https://www.vrbo.com/11887139ha', '11887139', 'ha', http)).toBe('117898910');
    });

    it('resolves from the meta itemprop identifier', async () => {
        const http = new FakeHttp(() => ({ text: '<meta itemprop="identifier" content="117898910"/>' }));
        expect(await resolveLegacyPropertyId('https://www.vrbo.com/11887139ha', '11887139', 'ha', http)).toBe('117898910');
    });

    it('returns the original id when nothing matches', async () => {
        const http = new FakeHttp(() => ({ text: '<html>no ids</html>' }));
        expect(await resolveLegacyPropertyId('https://www.vrbo.com/4084796', '4084796', '', http)).toBe('4084796');
    });

    it('returns the original id on a fetch error', async () => {
        const http = new FakeHttp(() => { throw new Error('network'); });
        expect(await resolveLegacyPropertyId('https://www.vrbo.com/4084796', '4084796', '', http)).toBe('4084796');
    });
});

describe('resolveShortUrl', () => {
    it('returns non-short urls unchanged without fetching', async () => {
        const http = new FakeHttp(() => { throw new Error('should not fetch'); });
        const u = 'https://www.vrbo.com/117898910';
        expect(await resolveShortUrl(u, http)).toBe(u);
        expect(http.calls).toHaveLength(0);
    });

    it('follows a 307 Location to the final vrbo url', async () => {
        const final = 'https://www.vrbo.com/117898910';
        const http = new FakeHttp((url) => (url.includes('t.vrbo.io') ? { status: 307, headers: { Location: final } } : null));
        expect(await resolveShortUrl('https://t.vrbo.io/abc', http)).toBe(final);
    });

    it('follows an app.link intermediary, then on to vrbo', async () => {
        const final = 'https://www.vrbo.com/117898910';
        const http = new FakeHttp((url) => {
            if (url.includes('t.vrbo.io')) return { status: 307, headers: { Location: 'https://a8ro.app.link/xyz' } };
            if (url.includes('app.link')) return { status: 307, headers: { Location: final } };
            return null;
        });
        expect(await resolveShortUrl('https://t.vrbo.io/abc', http)).toBe(final);
    });

    it('extracts a vrbo url from browser_fallback_url in a 200 body', async () => {
        const html = 'x browser_fallback_url=https%3A%2F%2Fwww.vrbo.com%2F117898910 y';
        const http = new FakeHttp((url) => (url.includes('t.vrbo.io') ? { status: 200, text: html } : null));
        expect(await resolveShortUrl('https://t.vrbo.io/abc', http)).toBe('https://www.vrbo.com/117898910');
    });

    it('isResolvableUrl detects short/deep links', () => {
        expect(isResolvableUrl('https://t.vrbo.io/abc')).toBe(true);
        expect(isResolvableUrl('https://expe.app.link/abc')).toBe(true);
        expect(isResolvableUrl('https://www.vrbo.com/1')).toBe(false);
    });
});

describe('convertHotelsComToExpedia', () => {
    it('cheap path: reads expediaPropertyId from the URL query (no fetch)', async () => {
        const http = new FakeHttp(() => { throw new Error('should not fetch'); });
        expect(await convertHotelsComToExpedia('https://www.hotels.com/ho1/x?expediaPropertyId=615323', http)).toBe('615323');
        expect(http.calls).toHaveLength(0);
        expect(extractExpediaIdFromUrl('https://www.hotels.com/x?selected=42')).toBe('42');
    });

    it('extracts the id from the itemProp identifier meta', async () => {
        const http = new FakeHttp(() => ({ text: '<meta itemProp="identifier" content="21856"/>', url: 'https://www.hotels.com/ho136900/x/' }));
        expect(await convertHotelsComToExpedia('https://www.hotels.com/ho136900/x/', http)).toBe('21856');
    });

    it('picks the most frequent productId', async () => {
        const http = new FakeHttp(() => ({ text: 'productId=111 productId=222 productId=222', url: 'https://www.hotels.com/ho136900/x/' }));
        expect(await convertHotelsComToExpedia('https://www.hotels.com/ho136900/x/', http)).toBe('222');
    });

    it('throws HotelsComDelistedError when the listing 301s away from /ho', async () => {
        const http = new FakeHttp(() => ({ text: '<html>home</html>', url: 'https://www.hotels.com/' }));
        await expect(convertHotelsComToExpedia('https://www.hotels.com/ho136900/x/', http)).rejects.toBeInstanceOf(HotelsComDelistedError);
    });
});
