import { describe, expect, it } from 'vitest';

import { HotelsComDelistedError, PropertyNotFoundError } from '../src/errors.js';
import {
    assertHotelsComListed,
    assertVrboDetailPage,
    findDestinationUrl,
    findExpediaId,
    findVrboPropertyId,
    isResolvableUrl,
    needsIdResolution,
} from '../src/resolvers.js';
import { loadPage } from './load-page.js';

describe('needsIdResolution - which Vrbo URLs carry a legacy id', () => {
    it.each([
        ['bare numeric', 'https://www.vrbo.com/117898910', '', false],
        ['pdp/lo', 'https://www.vrbo.com/en-ca/pdp/lo/1489839', '', false],
        ['native vb suffix', 'https://www.bookabach.co.nz/holiday-homes/p497962vb', 'vb', false],
        ['ha suffix', 'https://www.vrbo.com/11887139ha', 'ha', true],
        ['localized /p<id>', 'https://www.vrbo.com/en-gb/p11348801', '', true],
        ['/p<id> with a letter', 'https://www.vrbo.com/nl-nl/vakantiewoning/p2093105a', 'a', true],
    ])('%s -> %s', (_label, url, suffix, expected) => {
        expect(needsIdResolution(url, suffix)).toBe(expected);
    });
});

describe('findVrboPropertyId', () => {
    it('resolves the internal id from the og:image lodging path', () => {
        const html = '<img src="https://media.vrbo.com/lodging/118000000/117900000/117899000/117898910/abc.jpg">';
        expect(findVrboPropertyId(loadPage(html), '11887139')).toBe('117898910');
    });

    it('resolves from the meta itemprop identifier, in either attribute order', () => {
        expect(findVrboPropertyId(loadPage('<meta itemprop="identifier" content="117898910"/>'), '11887139')).toBe(
            '117898910',
        );
        expect(findVrboPropertyId(loadPage('<meta content="117898910" itemprop="identifier"/>'), '11887139')).toBe(
            '117898910',
        );
    });

    it('resolves from a data-property-id attribute', () => {
        expect(findVrboPropertyId(loadPage('<div data-property-id="117898910"></div>'), '11887139')).toBe('117898910');
    });

    it('returns the original id when nothing matches', () => {
        expect(findVrboPropertyId(loadPage('<html>no ids</html>'), '4084796')).toBe('4084796');
    });
});

describe('assertVrboDetailPage', () => {
    it('accepts a page that kept the requested id', () => {
        expect(() => assertVrboDetailPage('https://www.vrbo.com/en-gb/p11348801', '11348801')).not.toThrow();
    });

    it('rejects the homepage', () => {
        expect(() => assertVrboDetailPage('https://www.vrbo.com/', '117898910')).toThrow(PropertyNotFoundError);
    });

    it('rejects an area search page', () => {
        const landed = 'https://www.vrbo.com/tgp/vacation-rental/948522353206452224/santo-amaro';
        expect(() => assertVrboDetailPage(landed, '11887139')).toThrow(PropertyNotFoundError);
    });
});

describe('findDestinationUrl', () => {
    it('uses the landing URL once redirects have been followed', () => {
        expect(findDestinationUrl('https://www.vrbo.com/117898910', loadPage(''))).toBe(
            'https://www.vrbo.com/117898910',
        );
    });

    it('reads browser_fallback_url out of a Branch.io interstitial', () => {
        const html = 'x browser_fallback_url=https%3A%2F%2Fwww.vrbo.com%2F117898910 y';
        expect(findDestinationUrl('https://t.vrbo.io/abc', loadPage(html))).toBe('https://www.vrbo.com/117898910');
    });

    it('falls back to a property URL embedded in the page', () => {
        const html = '<a href="https://www.vrbo.com/117898910">open</a>';
        expect(findDestinationUrl('https://t.vrbo.io/abc', loadPage(html))).toBe('https://www.vrbo.com/117898910');
    });

    it('returns null when the link goes nowhere useful', () => {
        expect(
            findDestinationUrl('https://t.vrbo.io/abc', loadPage('<h1>That link could not be found</h1>')),
        ).toBeNull();
    });

    it('isResolvableUrl detects short/deep links', () => {
        expect(isResolvableUrl('https://t.vrbo.io/abc')).toBe(true);
        expect(isResolvableUrl('https://expe.app.link/abc')).toBe(true);
        expect(isResolvableUrl('https://www.vrbo.com/1')).toBe(false);
    });
});

describe('Hotels.com id conversion', () => {
    it('extracts the id from the itemProp identifier meta', () => {
        expect(findExpediaId(loadPage('<meta itemprop="identifier" content="21856"/>'))).toBe('21856');
    });

    it('picks the most frequent productId', () => {
        expect(findExpediaId(loadPage('<script>productId=111 productId=222 productId=222</script>'))).toBe('222');
    });

    it('returns null when the page carries no id', () => {
        expect(findExpediaId(loadPage('<html>a real page, just no ids</html>'))).toBeNull();
    });

    it('throws HotelsComDelistedError when the listing redirected away from /ho', () => {
        expect(() => assertHotelsComListed('https://www.hotels.com/ho136900/x/', 'https://www.hotels.com/')).toThrow(
            HotelsComDelistedError,
        );
    });

    it('accepts a landing URL that kept /ho<id>', () => {
        expect(() =>
            assertHotelsComListed(
                'https://www.hotels.com/ho118568/',
                'https://www.hotels.com/ho118568/holiday-inn-express/',
            ),
        ).not.toThrow();
    });
});
