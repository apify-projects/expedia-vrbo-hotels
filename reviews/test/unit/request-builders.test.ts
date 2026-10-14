import { describe, expect, it } from 'vitest';

import { EXPEDIA_HOST, HOTELS_HOST, LABELS, PAGE_SIZE, SITE_CONFIGS } from '../../src/consts.js';
import { buildReviewsRequest, buildStartRequests } from '../../src/request-builders.js';
import type { Input } from '../../src/types/input.js';
import type { ReviewsUserData } from '../../src/types/user-data.js';

const input = (startUrls: Input['startUrls'], overrides: Partial<Input> = {}): Input => ({
    startUrls,
    sortBy: 'Most relevant',
    minDate: '1990-01-01',
    ...overrides,
});

const reviewsRequest = (startIndex: number, propertyId = '10966026') =>
    buildReviewsRequest({ site: EXPEDIA_HOST, propertyId, startIndex, sortBy: 'Most recent', customData: {} });

describe('buildReviewsRequest', () => {
    it('gives every page its own uniqueKey', () => {
        // All pages POST to the same /graphql URL, so without this the request queue
        // would dedupe an entire property down to one page.
        const keys = [0, PAGE_SIZE, PAGE_SIZE * 2].map((startIndex) => reviewsRequest(startIndex).uniqueKey);

        expect(new Set(keys).size).toBe(3);
    });

    it('keeps uniqueKeys distinct across properties and sites', () => {
        expect(reviewsRequest(0, '111').uniqueKey).not.toBe(reviewsRequest(0, '222').uniqueKey);
        expect(reviewsRequest(0).uniqueKey).not.toBe(
            buildReviewsRequest({
                site: HOTELS_HOST,
                propertyId: '10966026',
                startIndex: 0,
                sortBy: 'Most recent',
                customData: {},
            }).uniqueKey,
        );
    });

    it('POSTs the paging window and the brand siteId the gateway expects', () => {
        const request = reviewsRequest(PAGE_SIZE);
        const [operation] = JSON.parse(request.payload as string);
        const { counts, selections } = operation.variables.searchCriteria.secondary;

        expect(request.method).toBe('POST');
        expect(operation.variables.propertyId).toBe('10966026');
        expect(operation.variables.context.siteId).toBe(SITE_CONFIGS[EXPEDIA_HOST].siteId);
        expect(counts).toEqual([
            { id: 'startIndex', value: PAGE_SIZE },
            { id: 'size', value: PAGE_SIZE },
        ]);
        expect(selections).toEqual([{ id: 'sortBy', value: 'NEWEST_TO_OLDEST' }]);
    });

    it('translates each sorting option to the API vocabulary', () => {
        const sortValue = (request: ReturnType<typeof buildReviewsRequest>) =>
            JSON.parse(request.payload as string)[0].variables.searchCriteria.secondary.selections[0].value;

        const build = (sortBy: Input['sortBy']) =>
            buildReviewsRequest({ site: EXPEDIA_HOST, propertyId: '1', startIndex: 0, sortBy, customData: {} });

        expect(sortValue(build('Most relevant'))).toBe('NEWEST_TO_OLDEST_BY_LANGUAGE');
        expect(sortValue(build('Highest guest rating'))).toBe('HIGHEST_TO_LOWEST_RATED');
        expect(sortValue(build('Lowest guest rating'))).toBe('LOWEST_TO_HIGHEST_RATED');
    });
});

describe('buildStartRequests', () => {
    it('sends an Expedia URL straight to the reviews API', () => {
        const [request] = buildStartRequests(
            input([{ url: 'https://www.expedia.com/Prague-Hotels-Hotel-Krystal.h10966026.Hotel-Information' }]),
        );
        const userData = request?.userData as ReviewsUserData;

        expect(request?.label).toBe(LABELS.REVIEWS);
        expect(userData.propertyId).toBe('10966026');
        expect(userData.startIndex).toBe(0);
    });

    it('sends a Hotels.com URL to the property-id lookup first', () => {
        const [request] = buildStartRequests(input([{ url: 'https://www.hotels.com/ho136900/' }]));

        expect(request?.label).toBe(LABELS.PROPERTY_ID);
        expect(request?.userData?.site).toBe(HOTELS_HOST);
    });

    it('carries the property URL without its tracking query string', () => {
        const [request] = buildStartRequests(
            input([{ url: 'https://www.vrbo.com/2060810?expediaPropertyId=57834301&sort=RECOMMENDED&top_cur=USD' }]),
        );

        expect(request?.userData?.propertyUrl).toBe('https://www.vrbo.com/2060810');
    });

    it('carries userData through as customData', () => {
        const [request] = buildStartRequests(
            input([{ url: 'https://www.expedia.com/x.h1.Hotel-Information', userData: { hotel: 'Krystal' } }]),
        );

        expect(request?.userData?.customData).toEqual({ hotel: 'Krystal' });
    });

    it('defaults customData to an empty object when none is given', () => {
        const [request] = buildStartRequests(input([{ url: 'https://www.expedia.com/x.h1.Hotel-Information' }]));

        expect(request?.userData?.customData).toEqual({});
    });

    it('skips unusable rows instead of failing the whole run', () => {
        const requests = buildStartRequests(
            input([
                { url: 'not a url' },
                { url: 'https://www.booking.com/hotel/cz/krystal.html' },
                { url: '' },
                { url: 'https://www.expedia.com/x.h1.Hotel-Information' },
            ]),
        );

        expect(requests).toHaveLength(1);
    });

    it('returns nothing for an empty input list', () => {
        expect(buildStartRequests(input([]))).toEqual([]);
    });
});
