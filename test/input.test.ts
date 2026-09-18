/**
 * The input stage: what a user pastes becomes crawler requests, and whatever
 * cannot be scraped is reported instead of dropped.
 */
import { describe, expect, it } from 'vitest';

import { buildStartRequests, parseInputUrl } from '../src/input.js';

const EXPEDIA = 'https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information';

describe('parseInputUrl', () => {
    it('adds the scheme a pasted URL is missing', () => {
        expect(parseInputUrl('www.vrbo.com/117898910')).toBe('https://www.vrbo.com/117898910');
    });

    it('trims surrounding whitespace', () => {
        expect(parseInputUrl(`  ${EXPEDIA}  `)).toBe(EXPEDIA);
    });

    it('rejects anything that is not http(s)', () => {
        expect(parseInputUrl('ftp://www.expedia.com/x.h525006.Hotel-Information')).toBeNull();
        expect(parseInputUrl('mailto:someone@example.com')).toBeNull();
        expect(parseInputUrl('')).toBeNull();
    });
});

describe('buildStartRequests', () => {
    it('routes each platform to its own handler', () => {
        const { requests } = buildStartRequests([
            EXPEDIA,
            'https://www.hotels.com/ho136900/x/',
            'https://www.vrbo.com/117898910',
            'https://t.vrbo.io/abc',
        ]);
        expect(requests.map((request) => request.label)).toEqual(['expedia', 'hotels.com', 'vrbo', 'short-link']);
    });

    it('fetches a page only where the id is not in the URL', () => {
        const { requests } = buildStartRequests([
            EXPEDIA, // id is in the path
            'https://www.vrbo.com/117898910', // id is in the path
            'https://www.hotels.com/ho136900/x/', // ho<id> is not a Property ID
            'https://www.vrbo.com/en-gb/p11348801', // legacy id, the page carries the real one
            'https://www.hotels.com/ho136900/x/?expediaPropertyId=21856', // id is in the query
        ]);
        expect(requests.map((request) => request.skipNavigation)).toEqual([true, true, false, false, true]);
    });

    it('drops duplicates and counts them, ignoring host case and a trailing slash', () => {
        const { requests, duplicateCount } = buildStartRequests([
            'https://www.vrbo.com/117898910',
            'https://www.VRBO.com/117898910',
            'https://www.vrbo.com/117898910/',
            EXPEDIA,
        ]);
        expect(requests).toHaveLength(2);
        expect(duplicateCount).toBe(2);
    });

    it('reports every unusable input with its own reason', () => {
        const { requests, unusable } = buildStartRequests([
            EXPEDIA,
            'https://www.booking.com/hotel/cz/x.html',
            'https://www.expedia.com/',
            'https://www.hotels.com/Hotel-Search?destination=Prague',
            'ftp://www.expedia.com/x.h525006.Hotel-Information',
        ]);
        expect(requests).toHaveLength(1);
        expect(unusable.map((entry) => entry.reason)).toEqual([
            'Unsupported domain: www.booking.com',
            expect.stringContaining('Could not extract property ID from Expedia URL'),
            expect.stringContaining('search pages work only with one property selected'),
            'Not a valid URL. Expected an absolute http(s) URL.',
        ]);
    });

    it('keeps the raw input on an unusable entry, so the error item names what was pasted', () => {
        const { unusable } = buildStartRequests(['  not a property url  ']);
        expect(unusable[0].raw).toBe('  not a property url  ');
    });
});
