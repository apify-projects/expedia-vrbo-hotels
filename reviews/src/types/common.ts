import type { PPE_EVENTS, SITE_CONFIGS, SORT_MAP } from '../consts.js';

export type CrawlerState = {
    reviewCounts: Record<string, number>;
};

export type SiteHost = keyof typeof SITE_CONFIGS;
export type SortBy = keyof typeof SORT_MAP;
export type PpeEvent = (typeof PPE_EVENTS)[keyof typeof PPE_EVENTS];
