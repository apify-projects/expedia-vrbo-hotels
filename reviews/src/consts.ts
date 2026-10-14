export const LABELS = {
    PROPERTY_ID: 'PROPERTY_ID',
    REVIEWS: 'REVIEWS',
} as const;

export const EXPEDIA_HOST = 'www.expedia.com';
export const HOTELS_HOST = 'www.hotels.com';
export const VRBO_HOST = 'www.vrbo.com';

type SiteConfig = {
    siteId: number;
    /** Only Expedia puts the property id in the URL; the others need it read off the page. */
    propertyIdPattern?: RegExp;
};

export const SITE_CONFIGS: Record<typeof EXPEDIA_HOST | typeof HOTELS_HOST | typeof VRBO_HOST, SiteConfig> = {
    [EXPEDIA_HOST]: { siteId: 1, propertyIdPattern: /\.h(\d+)\./ },
    [HOTELS_HOST]: { siteId: 300000001 },
    [VRBO_HOST]: { siteId: 9001001 },
};

/** The gateway caps a page at 50 whatever `size` asks for, so a larger size reads as an early last page. */
export const PAGE_SIZE = 50;

export const SORT_MAP = {
    'Most relevant': 'NEWEST_TO_OLDEST_BY_LANGUAGE',
    'Most recent': 'NEWEST_TO_OLDEST',
    'Highest guest rating': 'HIGHEST_TO_LOWEST_RATED',
    'Lowest guest rating': 'LOWEST_TO_HIGHEST_RATED',
} as const;

export const PPE_EVENTS = {
    START: 'start',
    RESULT: 'result',
} as const;
