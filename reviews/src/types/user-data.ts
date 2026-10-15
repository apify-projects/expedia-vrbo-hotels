import type { SiteHost, SortBy } from './common.js';

export type BaseUserData = {
    site: SiteHost;
    propertyUrl: string;
    customData: Record<string, unknown>;
    sortBy: SortBy;
    maxReviewsPerHotel?: number;
    /** `YYYY-MM-DD` cutoff, absent when there is no date filter. */
    minDate?: string;
};

export type PropertyIdUserData = BaseUserData;

export type ReviewsUserData = BaseUserData & {
    propertyId: string;
    startIndex: number;
};
