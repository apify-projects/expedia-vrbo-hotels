import { describe, expect, it } from 'vitest';

import { URLParseError } from '../src/errors.js';
import { detectPlatform, extractPropertyId, extractVrboPropertyId, numericId, validateUrl } from '../src/url-parser.js';

describe('extractPropertyId — generic (ported example cases)', () => {
    it.each([
        [
            'https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information?chkin=2023-03-17',
            '525006',
            'expedia',
        ],
        [
            'https://www.expedia.it/en/Berchtesgaden-Hotels-Alpensport-Hotel-Seimler.h2692552.Hotel-Information',
            '2692552',
            'expedia',
        ],
        ['https://www.expedia.com/Prague-Hotels-Hotel-Krystal.h10966026.Hotel-Information', '10966026', 'expedia'],
        ['https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/', '136900', 'hotels.com'],
        ['https://www.vrbo.com/1234567', '1234567', 'vrbo'],
        ['https://www.vrbo.com/rental/9876543', '9876543', 'vrbo'],
        ['https://www.vrbo.com/en-us/vacation-rental/p1234567vb', '1234567', 'vrbo'],
        ['https://www.vrbo.com/en-gb/p11348801', '11348801', 'vrbo'],
    ])('%s -> %s/%s', (url, id, platform) => {
        expect(extractPropertyId(url)).toEqual([id, platform]);
    });

    it('throws URLParseError on unsupported domain', () => {
        expect(() => extractPropertyId('https://www.booking.com/hotel/x.html')).toThrow(URLParseError);
    });

    it('throws URLParseError on empty input', () => {
        expect(() => extractPropertyId('')).toThrow(URLParseError);
    });
});

describe('extractVrboPropertyId — id + suffix', () => {
    it.each([
        ['https://www.vrbo.com/1234567', '1234567', ''],
        ['https://www.vrbo.com/10739791ha', '10739791', 'ha'],
        ['https://www.vrbo.com/11887139ha', '11887139', 'ha'],
        ['https://www.vrbo.com/nl-nl/vakantiewoning/p2093105a', '2093105', 'a'],
        ['https://www.vrbo.com/en-us/vacation-rental/p1234567vb', '1234567', 'vb'],
        ['https://www.vrbo.com/en-gb/p11348801', '11348801', ''],
        ['https://www.bookabach.co.nz/holiday-homes/p497962vb', '497962', 'vb'],
        ['https://www.vrbo.com/en-ca/pdp/lo/1489839', '1489839', ''],
    ])('%s -> %s/%s', (url, id, suffix) => {
        expect(extractVrboPropertyId(url)).toEqual([id, suffix]);
    });

    it('returns [null, null] for non-http', () => {
        expect(extractVrboPropertyId('vrbo.com/1234567')).toEqual([null, null]);
    });
});

describe('detectPlatform / validateUrl / numericId', () => {
    it('detects platforms', () => {
        expect(detectPlatform('https://www.vrbo.com/1234567')).toBe('vrbo');
        expect(detectPlatform('https://www.expedia.com/x.h525006.Hotel-Information')).toBe('expedia');
        expect(detectPlatform('https://www.hotels.com/ho136900/x/')).toBe('hotels.com');
    });

    it('returns null for unrecognized platform', () => {
        expect(detectPlatform('https://www.booking.com/hotel/x.html')).toBeNull();
    });

    it('validateUrl', () => {
        expect(validateUrl('https://www.vrbo.com/1234567')).toBe(true);
        expect(validateUrl('https://www.booking.com/x')).toBe(false);
    });

    it('numericId strips non-digits', () => {
        expect(numericId('11887139ha')).toBe('11887139');
        expect(numericId('4084796')).toBe('4084796');
    });
});
