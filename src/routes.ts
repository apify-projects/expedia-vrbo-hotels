/**
 * One route per Platform, plus one that follows a short link and re-enqueues the
 * destination. Each property route produces exactly one dataset row; error rows
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
    extractExpediaIdFromUrl,
    findDestinationUrl,
    findExpediaId,
    findVrboPropertyId,
    HOMEAWAY_HTML_HEADERS,
    HOTELS_COM_HEADERS,
    needsIdResolution,
} from './resolvers.js';
import { detectExpediaSite, EXPEDIA_SITE_CONFIGS, VRBO_SITE_CONFIGS } from './site-configs.js';
import type { PropertyResult } from './types.js';
import { extractPropertyId, extractVrboPropertyId, type Platform } from './url-parser.js';

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

/** Fetch everything for one property and format the single output row. */
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
    const [parsedId, suffix] = extractVrboPropertyId(request.url);
    if (!parsedId) throw new URLParseError(`Could not extract property ID from Vrbo URL: ${request.url}`);

    let propertyId = parsedId;
    if (needsIdResolution(request.url, suffix ?? '')) {
        assertPageHasContent($, request.url);
        assertVrboDetailPage(request.loadedUrl ?? request.url, parsedId);
        propertyId = findVrboPropertyId($, parsedId);
    }

    const row = await scrapeProperty({ url: request.url, platform: 'vrbo', propertyId, sendRequest });
    await pushRow(row, request.url, log);
});

router.addHandler(LABELS.EXPEDIA, async ({ request, sendRequest, log }) => {
    const [propertyId] = extractPropertyId(request.url);
    const row = await scrapeProperty({ url: request.url, platform: 'expedia', propertyId, sendRequest });
    await pushRow(row, request.url, log);
});

router.addHandler(LABELS.HOTELS_COM, async ({ request, $, sendRequest, log }) => {
    // Hotels.com uses different ids than Expedia; the page carries the mapping.
    let expediaId = extractExpediaIdFromUrl(request.url);
    if (!expediaId) {
        assertPageHasContent($, request.url);
        assertHotelsComListed(request.url, request.loadedUrl ?? request.url);
        expediaId = findExpediaId($);
    }
    if (!expediaId) {
        throw new URLParseError(`Hotels.com page loaded but contained no Expedia property ID: ${request.url}`);
    }

    const row = await scrapeProperty({ url: request.url, platform: 'hotels.com', propertyId: expediaId, sendRequest });
    await pushRow(row, request.url, log);
});

async function pushRow(row: PropertyResult, url: string, log: Log): Promise<void> {
    await Actor.pushData(row);
    log.info(`Scraped ${row.name} (${url})`);
}

/**
 * Build the queue entry for one property URL. Only Hotels.com and legacy Vrbo
 * URLs need their page, so everything else skips the fetch the crawler would
 * otherwise make.
 */
export function buildPropertyRequest(url: string, platform: Platform) {
    const needsPage =
        platform === 'hotels.com'
            ? extractExpediaIdFromUrl(url) === null
            : platform === 'vrbo' && needsIdResolution(url, extractVrboPropertyId(url)[1] ?? '');

    return {
        url,
        label: PLATFORM_LABEL_MAP[platform],
        skipNavigation: !needsPage,
        headers: platform === 'hotels.com' ? HOTELS_COM_HEADERS : HOMEAWAY_HTML_HEADERS,
    };
}
