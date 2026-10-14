import { describe, expect, it } from 'vitest';

import { EXPEDIA_HOST, HOTELS_HOST, PAGE_SIZE, VRBO_HOST } from '../../src/consts.js';
import { buildRemainingStartIndexes, findPropertyIdInUrl, resolveSiteHost } from '../../src/utils/urls.js';

describe('resolveSiteHost', () => {
    it('maps regional Expedia domains onto the Expedia gateway', () => {
        expect(resolveSiteHost('www.expedia.com')).toBe(EXPEDIA_HOST);
        expect(resolveSiteHost('www.expedia.it')).toBe(EXPEDIA_HOST);
        expect(resolveSiteHost('www.expedia.com.tw')).toBe(EXPEDIA_HOST);
    });

    it('maps Hotels.com and its Portuguese domain onto the Hotels.com gateway', () => {
        expect(resolveSiteHost('www.hotels.com')).toBe(HOTELS_HOST);
        expect(resolveSiteHost('de.hotels.com')).toBe(HOTELS_HOST);
        expect(resolveSiteHost('www.hoteis.com')).toBe(HOTELS_HOST);
    });

    it('maps Vrbo onto the Vrbo gateway', () => {
        expect(resolveSiteHost('www.vrbo.com')).toBe(VRBO_HOST);
    });

    it('is case insensitive', () => {
        expect(resolveSiteHost('WWW.Expedia.COM')).toBe(EXPEDIA_HOST);
    });

    it('returns undefined for a site this Actor does not handle', () => {
        expect(resolveSiteHost('www.booking.com')).toBeUndefined();
    });
});

describe('findPropertyIdInUrl', () => {
    it('reads the property id out of an Expedia path', () => {
        const url = new URL('https://www.expedia.com/Prague-Hotels-Hotel-Krystal.h10966026.Hotel-Information');

        expect(findPropertyIdInUrl(url, EXPEDIA_HOST)).toBe('10966026');
    });

    it('ignores the query string', () => {
        const url = new URL('https://www.expedia.com/Prague-Pentahotel.h525006.Hotel-Information?chkin=2023-03-17');

        expect(findPropertyIdInUrl(url, EXPEDIA_HOST)).toBe('525006');
    });

    it('returns undefined for Hotels.com, whose URL id is not the property id', () => {
        // ho136900 in the URL is the listing id; the API needs 21856.
        const url = new URL('https://www.hotels.com/ho136900/hilton-prague-old-town/');

        expect(findPropertyIdInUrl(url, HOTELS_HOST)).toBeUndefined();
    });

    it('prefers the expediaPropertyId a search-result link carries', () => {
        // Saves the listing-page fetch, which is the request Vrbo rate-limits hardest.
        const vrbo = new URL('https://www.vrbo.com/2060810?selectedRoomType=57834301&expediaPropertyId=57834301');
        expect(findPropertyIdInUrl(vrbo, VRBO_HOST)).toBe('57834301');

        const hotels = new URL('https://www.hotels.com/ho140372/k-k-hotel-fenix/?expediaPropertyId=425227');
        expect(findPropertyIdInUrl(hotels, HOTELS_HOST)).toBe('425227');
    });

    it('lets the query id win over a path id, since both name the same property', () => {
        const url = new URL('https://www.expedia.com/x.h425227.Hotel-Information?expediaPropertyId=425227');

        expect(findPropertyIdInUrl(url, EXPEDIA_HOST)).toBe('425227');
    });

    it('ignores a non-numeric expediaPropertyId', () => {
        const url = new URL('https://www.hotels.com/ho140372/?expediaPropertyId=abc');

        expect(findPropertyIdInUrl(url, HOTELS_HOST)).toBeUndefined();
    });

    it('returns undefined for an Expedia URL with no property id in it', () => {
        expect(findPropertyIdInUrl(new URL('https://www.expedia.com/Hotel-Search'), EXPEDIA_HOST)).toBeUndefined();
    });
});

describe('buildRemainingStartIndexes', () => {
    it('covers every page after the first', () => {
        // 236 reviews at 50 per page is 5 pages, and page one is already done.
        expect(buildRemainingStartIndexes(236)).toEqual([50, 100, 150, 200]);
    });

    it('returns nothing when a single page holds everything', () => {
        expect(buildRemainingStartIndexes(50)).toEqual([]);
        expect(buildRemainingStartIndexes(12)).toEqual([]);
        expect(buildRemainingStartIndexes(0)).toEqual([]);
    });

    it('stops at the per-hotel limit rather than the property total', () => {
        expect(buildRemainingStartIndexes(1000, 120)).toEqual([50, 100]);
    });

    it('never queues a page the limit fully excludes', () => {
        expect(buildRemainingStartIndexes(1000, 50)).toEqual([]);
    });

    it('queues one page past a total that is an exact multiple of the page size', () => {
        expect(buildRemainingStartIndexes(100)).toEqual([50]);
    });

    it('pages at the size the API actually honors', () => {
        // Regression guard: the previous version asked for 100 per page, got 50, and read
        // the short page as "no more reviews" - so it only ever scraped the first page.
        expect(PAGE_SIZE).toBe(50);
        expect(buildRemainingStartIndexes(PAGE_SIZE * 3)).toEqual([PAGE_SIZE, PAGE_SIZE * 2]);
    });
});

describe('buildRemainingStartIndexes with a run-wide cap', () => {
    it('stops at whichever limit is lower', () => {
        // maxReviewsPerHotel vs the run's paid-items cap - the route passes the min.
        expect(buildRemainingStartIndexes(1000, Math.min(500, 120))).toEqual([50, 100]);
        expect(buildRemainingStartIndexes(1000, Math.min(120, 60))).toEqual([50]);
    });

    it('treats an absent cap as unlimited', () => {
        expect(buildRemainingStartIndexes(160, Math.min(Infinity, Infinity))).toEqual([50, 100, 150]);
    });
});
