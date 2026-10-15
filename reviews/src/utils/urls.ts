import { EXPEDIA_HOST, HOTELS_HOST, PAGE_SIZE, SITE_CONFIGS, VRBO_HOST } from '../consts.js';
import type { SiteHost } from '../types/common.js';

/** Regional domains (expedia.it, de.hotels.com, hoteis.com) all serve the same API under one host per brand. */
export const resolveSiteHost = (hostname: string): SiteHost | undefined => {
    const host = hostname.toLowerCase();

    if (host.endsWith('hotels.com') || host.endsWith('hoteis.com')) return HOTELS_HOST;
    if (host.includes('vrbo')) return VRBO_HOST;
    if (host.includes('expedia')) return EXPEDIA_HOST;

    return undefined;
};

export const findPropertyIdInUrl = (url: URL, site: SiteHost): string | undefined => {
    // Links copied out of a search result carry the id, which saves fetching the listing page.
    const fromQuery = url.searchParams.get('expediaPropertyId');
    if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

    const { propertyIdPattern } = SITE_CONFIGS[site];

    return propertyIdPattern ? url.pathname.match(propertyIdPattern)?.[1] : undefined;
};

export const buildRemainingStartIndexes = (totalCount: number, maxReviewsPerHotel = Infinity): number[] => {
    const reviewsToScrape = Math.min(totalCount, maxReviewsPerHotel);
    const startIndexes: number[] = [];

    for (let startIndex = PAGE_SIZE; startIndex < reviewsToScrape; startIndex += PAGE_SIZE) {
        startIndexes.push(startIndex);
    }

    return startIndexes;
};
