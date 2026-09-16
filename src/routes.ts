/**
 * One route per Platform, plus one that follows a short link and re-enqueues the
 * destination. Each property route produces exactly one dataset item; error items
 * come from main's failedRequestHandler.
 *
 * Requests whose page we actually need (Hotels.com, legacy Vrbo) are navigated
 * by the crawler, so blocks and retries on that fetch are the session pool's job.
 * The rest set `skipNavigation` and talk only to the GraphQL endpoint.
 */
import { Actor } from 'apify';
import { type CheerioAPI, createCheerioRouter, type Log } from 'crawlee';

import { BlockedResponseError, URLParseError } from './errors.js';
import { formatProperty } from './formatter.js';
import { makeExpediaProfile, makeVrboProfile, PropertyClient, type SendRequest } from './property-client.js';
import {
    assertHotelsComListed,
    assertVrboDetailPage,
    findDestinationUrl,
    findExpediaId,
    findVrboPropertyId,
    HOMEAWAY_HTML_HEADERS,
    HOTELS_COM_HEADERS,
    needsIdResolution,
} from './resolvers.js';
import { detectExpediaSite, EXPEDIA_SITE_CONFIGS, VRBO_SITE_CONFIGS } from './site-configs.js';
import type { PropertyResult } from './types.js';
import { extractPropertyId, extractVrboPropertyId, findPropertyIdInQuery, type Platform } from './url-parser.js';

export const LABELS = {
    SHORT_LINK: 'short-link',
    VRBO: 'vrbo',
    EXPEDIA: 'expedia',
    HOTELS_COM: 'hotels.com',
} as const;

export type Label = (typeof LABELS)[keyof typeof LABELS];

/** Label a URL already known to belong to a Platform. */
export const PLATFORM_LABEL_MAP: Record<Platform, Label> = {
    vrbo: LABELS.VRBO,
    expedia: LABELS.EXPEDIA,
    'hotels.com': LABELS.HOTELS_COM,
};

export interface ScrapeArgs {
    url: string;
    platform: Platform;
    propertyId: string;
    sendRequest: SendRequest;
}

/**
 * Vrbo always goes through vrbo.com - regional endpoints can return wrong data
 * for some ids - and Hotels.com through Expedia, whose endpoint does not
 * soft-block through residential proxies.
 */
function buildClient(platform: Platform, url: string, sendRequest: SendRequest): PropertyClient {
    if (platform === 'vrbo') {
        return new PropertyClient({ profile: makeVrboProfile(), site: VRBO_SITE_CONFIGS['vrbo.com'], sendRequest });
    }
    const siteKey = platform === 'expedia' ? (detectExpediaSite(url) ?? 'expedia.com') : 'expedia.com';
    const site = EXPEDIA_SITE_CONFIGS[siteKey];
    return new PropertyClient({ profile: makeExpediaProfile(site), site, sendRequest });
}

/** Fetch everything for one property and format the single output item. */
export async function scrapeProperty({ url, platform, propertyId, sendRequest }: ScrapeArgs): Promise<PropertyResult> {
    const client = buildClient(platform, url, sendRequest);
    const [summaryData, contentData, galleryData, offersData, pageLayoutData] = await Promise.all([
        client.fetchPropertySummary(propertyId),
        client.fetchPropertyDetails(propertyId),
        client.fetchProductGallery(propertyId),
        client.fetchPropertyOffers(propertyId),
        platform === 'vrbo' ? client.fetchPageLayout(propertyId) : null,
    ]);
    return formatProperty({
        summaryData,
        contentData,
        url,
        propertyId,
        platform,
        galleryData,
        offersData,
        pageLayoutData,
    });
}

/**
 * Whether the Property ID has to be read off the page. The request builder and
 * the routes both ask, and they must agree: a request built with
 * `skipNavigation` has no page for a route to read.
 */
function needsPageForId(url: string, platform: Platform): boolean {
    if (findPropertyIdInQuery(url) !== null) return false;
    if (platform === 'hotels.com') return true;
    return platform === 'vrbo' && needsIdResolution(url, extractVrboPropertyId(url)[1] ?? '');
}

/** This target soft-blocks with a 200 that is empty, or a bare html skeleton. */
export function assertPageHasContent($: CheerioAPI, url: string): void {
    if (!$.root().text().trim()) throw new BlockedResponseError(`Empty page from ${url} - soft-block`);
}

export const router = createCheerioRouter();

router.addHandler(LABELS.SHORT_LINK, async ({ request, $, log, addRequests }) => {
    assertPageHasContent($, request.url);
    const destination = findDestinationUrl(request.loadedUrl ?? request.url, $);
    if (!destination) throw new URLParseError(`Could not resolve short link: ${request.url}`);

    const [, platform] = extractPropertyId(destination);
    log.info(`Short link ${request.url} resolved to ${destination}`);
    await addRequests([buildPropertyRequest(destination, platform)]);
});

router.addHandler(LABELS.VRBO, async ({ request, $, sendRequest, log }) => {
    // Always scrape via vrbo.com - regional endpoints can return wrong data.
    const [parsedId] = extractVrboPropertyId(request.url);
    if (!parsedId) throw new URLParseError(`Could not extract property ID from Vrbo URL: ${request.url}`);

    let propertyId = parsedId;
    if (needsPageForId(request.url, 'vrbo')) {
        assertPageHasContent($, request.url);
        assertVrboDetailPage(request.loadedUrl ?? request.url, parsedId);
        propertyId = findVrboPropertyId($, parsedId);
    }

    const item = await scrapeProperty({ url: request.url, platform: 'vrbo', propertyId, sendRequest });
    await pushItem(item, request.url, log);
});

router.addHandler(LABELS.EXPEDIA, async ({ request, sendRequest, log }) => {
    const [propertyId] = extractPropertyId(request.url);
    const item = await scrapeProperty({ url: request.url, platform: 'expedia', propertyId, sendRequest });
    await pushItem(item, request.url, log);
});

router.addHandler(LABELS.HOTELS_COM, async ({ request, $, sendRequest, log }) => {
    // Hotels.com uses different ids than Expedia; the page carries the mapping.
    let expediaId = findPropertyIdInQuery(request.url);
    if (!expediaId) {
        assertPageHasContent($, request.url);
        assertHotelsComListed(request.url, request.loadedUrl ?? request.url);
        expediaId = findExpediaId($);
    }
    if (!expediaId) {
        throw new URLParseError(`Hotels.com page loaded but contained no Expedia property ID: ${request.url}`);
    }

    const item = await scrapeProperty({ url: request.url, platform: 'hotels.com', propertyId: expediaId, sendRequest });
    await pushItem(item, request.url, log);
});

async function pushItem(item: PropertyResult, url: string, log: Log): Promise<void> {
    await Actor.pushData(item);
    log.info(`Scraped ${item.name} (${url})`);
}

/**
 * Build the queue entry for one property URL. Only Hotels.com and legacy Vrbo
 * URLs need their page, so everything else skips the fetch the crawler would
 * otherwise make.
 */
export function buildPropertyRequest(url: string, platform: Platform) {
    return {
        url,
        label: PLATFORM_LABEL_MAP[platform],
        skipNavigation: !needsPageForId(url, platform),
        headers: platform === 'hotels.com' ? HOTELS_COM_HEADERS : HOMEAWAY_HTML_HEADERS,
    };
}
