import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import { extractPropertyId } from '../../../src/extractors/property.js';
import { readFixture } from '../../helpers.js';

const extract = (html: string) => extractPropertyId(load(html) as never);

describe('extractPropertyId', () => {
    it('reads the id from a captured Hotels.com property page', () => {
        // The fixture is the real script element off www.hotels.com/ho136900/, where the
        // listing id in the URL is 136900 but the API needs 21856.
        expect(extract(readFixture('hotels-com-property-page.html'))).toBe('21856');
    });

    it('reads the id at any escaping depth', () => {
        expect(extract('<script>{"propertyId":"21856"}</script>')).toBe('21856');
        expect(extract(`<script>{${String.raw`\"propertyId\":\"21856\"`}}</script>`)).toBe('21856');
        expect(extract(`<script>{${String.raw`\\\"propertyId\\\":\\\"21856\\\"`}}</script>`)).toBe('21856');
    });

    it('tolerates whitespace around the colon', () => {
        expect(extract('<script>{"propertyId" : "1166955"}</script>')).toBe('1166955');
    });

    it('falls back to the Vrbo meta tag', () => {
        expect(extract('<head><meta itemprop="identifier" content="1166955"></head>')).toBe('1166955');
    });

    it('prefers the script blob over the meta tag when a page has both', () => {
        const html = `<head><meta itemprop="identifier" content="999"></head><script>{"propertyId":"21856"}</script>`;

        expect(extract(html)).toBe('21856');
    });

    it('scans past a script that has no id in it', () => {
        expect(extract('<script>var a = 1;</script><script>{"propertyId":"21856"}</script>')).toBe('21856');
    });

    it('returns undefined when the page carries no id', () => {
        expect(extract('<body><h1>Not a property page</h1></body>')).toBeUndefined();
    });

    it('returns undefined for an empty meta tag rather than an empty string', () => {
        expect(extract('<meta itemprop="identifier" content="">')).toBeUndefined();
    });
});
