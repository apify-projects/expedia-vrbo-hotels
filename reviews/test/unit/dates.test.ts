import { describe, expect, it } from 'vitest';

import { getMinDate, parseReviewDate } from '../../src/utils/dates.js';

describe('parseReviewDate', () => {
    it('parses the API date format as UTC', () => {
        expect(parseReviewDate('Apr 15, 2022')?.toISOString()).toBe('2022-04-15T00:00:00.000Z');
        expect(parseReviewDate('Oct 25, 2024')?.toISOString()).toBe('2024-10-25T00:00:00.000Z');
    });

    it('returns undefined for an absent or unparseable date', () => {
        expect(parseReviewDate(undefined)).toBeUndefined();
        expect(parseReviewDate(null)).toBeUndefined();
        expect(parseReviewDate('')).toBeUndefined();
        expect(parseReviewDate('not a date')).toBeUndefined();
    });
});

describe('getMinDate', () => {
    it('keeps the date the datepicker produced', () => {
        expect(getMinDate('Most recent', '2024-01-25')).toBe('2024-01-25');
    });

    it('has no cutoff for the schema default', () => {
        expect(getMinDate('Most recent', '1990-01-01')).toBeUndefined();
    });

    it('ignores the cutoff under sorts that are not date-ordered', () => {
        // Most relevant maps to NEWEST_TO_OLDEST_BY_LANGUAGE, which despite the name is
        // not strictly newest-first, so stopping early on it would drop qualifying reviews.
        expect(getMinDate('Most relevant', '2024-01-25')).toBeUndefined();
        expect(getMinDate('Highest guest rating', '2024-01-25')).toBeUndefined();
        expect(getMinDate('Lowest guest rating', '2024-01-25')).toBeUndefined();
    });

    it('has no cutoff when the date is missing or malformed', () => {
        expect(getMinDate('Most recent', undefined)).toBeUndefined();
        expect(getMinDate('Most recent', '')).toBeUndefined();
        expect(getMinDate('Most recent', 'yesterday')).toBeUndefined();
        expect(getMinDate('Most recent', 'a few weeks')).toBeUndefined();
    });
});
