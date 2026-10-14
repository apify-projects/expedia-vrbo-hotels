import { describe, expect, it } from 'vitest';

import { extractReview, extractReviewsPage } from '../../../src/extractors/review.js';
import type { ResponseReview, ResponseReviewsPage } from '../../../src/types/responses.js';
import { readJsonFixture } from '../../helpers.js';

// Real responses, each trimmed to three reviews. Hotels.com sends the author region and
// management responses; Expedia sends themes, photos and helpful votes instead.
const hotelsPage = () => readJsonFixture<ResponseReviewsPage>('reviews-page.json');
const expediaPage = () => readJsonFixture<ResponseReviewsPage>('expedia-reviews-page.json');

const context = {
    hotelId: '21856',
    propertyUrl: 'https://www.hotels.com/ho136900/',
    reviewPosition: 1,
    customData: {},
};
const extractAll = (page: ResponseReviewsPage) =>
    extractReviewsPage(page)!.reviews.map((review) => extractReview(review, context));

describe('extractReviewsPage', () => {
    it('reads the reviews and the property total off a Hotels.com response', () => {
        const page = extractReviewsPage(hotelsPage());

        expect(page?.reviews).toHaveLength(3);
        expect(page?.totalCount).toBe(1002);
    });

    it('reads an Expedia response the same way', () => {
        const page = extractReviewsPage(expediaPage());

        expect(page?.reviews).toHaveLength(3);
        expect(page?.totalCount).toBe(236);
    });

    it('reads an empty page without treating it as malformed', () => {
        const response: ResponseReviewsPage = [{ data: { propertyInfo: { reviewInfo: { reviews: [] } } } }];

        expect(extractReviewsPage(response)).toEqual({ reviews: [], totalCount: undefined });
    });

    it('returns undefined when the body carries no reviews array', () => {
        // How a throttled gateway answers under a 200 - the caller must retry rather
        // than record the property as having no reviews.
        expect(extractReviewsPage([{ errors: [{ message: 'Provisioned rate exceeded' }] }])).toBeUndefined();
        expect(extractReviewsPage([{ data: {} }])).toBeUndefined();
        expect(extractReviewsPage([])).toBeUndefined();
    });
});

describe('extractReview', () => {
    it('turns the rating string into a number and keeps its wording', () => {
        const [review] = extractAll(hotelsPage());

        expect(review!.rating).toBe(10);
        expect(review!.ratingText).toBe('Exceptional');
    });

    it('reads dates as ISO, not the API display format', () => {
        for (const review of [...extractAll(hotelsPage()), ...extractAll(expediaPage())]) {
            expect(review.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it('resolves the author from whichever field the site populates', () => {
        // Hotels.com leaves reviewAuthorAttribution null and only fills the footer.
        expect(extractAll(hotelsPage()).every((review) => review.authorName)).toBe(true);
        expect(extractAll(expediaPage()).every((review) => review.authorName)).toBe(true);
    });

    it('uppercases the author country when the site sends one', () => {
        expect(extractAll(hotelsPage())[0]!.authorCountryCode).toBe('US');
        expect(extractAll(expediaPage())[0]!.authorCountryCode).toBeNull();
    });

    it('pulls the nights stayed out of both stay-detail wordings', () => {
        // Hotels.com writes "Christian, 5-night trip", Expedia "Stayed 3 nights in Oct 2024".
        expect(extractAll(hotelsPage())[0]!.nightsStayed).toBe(5);
        expect(extractAll(expediaPage()).some((review) => review.nightsStayed !== null)).toBe(true);
    });

    it('reads the stay month only from the wording that carries one', () => {
        expect(extractAll(hotelsPage())[0]!.stayedMonth).toBeNull();
        expect(extractAll(expediaPage())[0]!.stayedMonth).toMatch(/^\d{4}-\d{2}$/);
    });

    it('splits themes by sentiment and evens out their casing', () => {
        const themed = extractAll(expediaPage()).find((review) => review.likedThemes.length > 0);

        expect(themed!.likedThemes.length).toBeGreaterThan(1);
        for (const theme of themed!.likedThemes) expect(theme[0]).toBe(theme[0]!.toUpperCase());
    });

    it('flattens management responses and parses the header', () => {
        const [response] = extractAll(hotelsPage()).flatMap((review) => review.managementResponses);

        expect(response!.authorName).toBeTruthy();
        expect(response!.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(response!.text).toBeTruthy();
    });

    it('reports helpful votes as a number, or null where the site omits them', () => {
        expect(extractAll(expediaPage())[0]!.helpfulVoteCount).toEqual(expect.any(Number));
        expect(extractAll(hotelsPage())[0]!.helpfulVoteCount).toBeNull();
    });

    it('nulls the empty strings the API uses for a missing title or text', () => {
        const review = extractReview(
            { ...extractReviewsPage(hotelsPage())!.reviews[0]!, title: '', text: '' },
            context,
        );

        expect(review.title).toBeNull();
        expect(review.text).toBeNull();
    });

    it('keeps collections as empty arrays rather than null', () => {
        const raw = extractReviewsPage(hotelsPage())!.reviews[0]!;
        const review = extractReview({ ...raw, themes: null, photos: [], managementResponses: [] }, context);

        expect(review).toMatchObject({
            likedThemes: [],
            dislikedThemes: [],
            photoUrls: [],
            managementResponses: [],
        });
    });

    it('drops the analytics and UI wrappers the API sends alongside', () => {
        const review = extractAll(expediaPage())[0] as Record<string, unknown>;

        for (const key of [
            '__typename',
            'reviewAnalytics',
            'seeMoreAnalytics',
            'impressionAnalytics',
            'photoSection',
            'reviewFooter',
            'reviewInteractionSections',
            'reviewScoreWithDescription',
            'submissionTime',
            'superlative',
            'disclaimer',
            'brandType',
            'travelers',
            'highlightedText',
            'propertyReviewSource',
        ]) {
            expect(review).not.toHaveProperty(key);
        }
    });

    it('passes the input userData straight through as customData', () => {
        const raw = extractReviewsPage(hotelsPage())!.reviews[0]! as ResponseReview;
        const customData = { hotel: 'Hilton Old Town', tags: ['a', 'b'], nested: { deep: 1 } };

        const review = extractReview(raw, { ...context, reviewPosition: 7, customData });

        expect(review.customData).toEqual(customData);
        expect(review.reviewPosition).toBe(7);
        expect(review.hotelId).toBe('21856');
        expect(review.propertyUrl).toBe('https://www.hotels.com/ho136900/');
    });
});
