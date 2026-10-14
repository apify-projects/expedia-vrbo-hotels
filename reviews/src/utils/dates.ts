import type { SortBy } from '../types/common.js';

const DEFAULT_MIN_DATE = '1990-01-01';

/** The API only gives a `"Apr 15, 2022"` date, read as UTC so it does not drift with the run's timezone. */
export const parseReviewDate = (longDateFormat?: string | null): Date | undefined => {
    if (!longDateFormat) return undefined;

    const date = new Date(`${longDateFormat} UTC`);

    return Number.isNaN(date.getTime()) ? undefined : date;
};

export const getMinDate = (sortBy: SortBy, minDate?: string): string | undefined => {
    if (sortBy !== 'Most recent') return undefined;
    if (!minDate || minDate === DEFAULT_MIN_DATE) return undefined;

    const date = new Date(minDate);

    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};
