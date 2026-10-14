import type { SortBy } from './common.js';

export type Input = {
    startUrls: { url: string; userData?: Record<string, unknown> }[];
    maxReviewsPerHotel?: number;
    sortBy: SortBy;
    minDate: string;
    debugLog?: boolean;
};
