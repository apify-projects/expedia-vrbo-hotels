/**
 * Per-URL pipeline: the unit of work behind one Terminal row.
 *
 * resolve short/deep link → detect platform → resolve the Property ID →
 * 5 parallel GraphQL fetches → validate → format. This is the deterministic
 * seam the tests drive with a fake HttpClient (the "faked impit boundary"):
 * everything that touches the network goes through `deps.makeClient`.
 *
 * Faithful port of `main.py`'s scrape_property / scrape_vrbo / scrape_expedia /
 * scrape_hotels.
 */
import { URLParseError } from './errors.js';
import { formatProperty } from './formatter.js';
import type { HttpClient } from './http/http-client.js';
import {
    makeExpediaProfile,
    makeVrboProfile,
    PropertyClient,
} from './property-client.js';
import {
    convertHotelsComToExpedia,
    resolveLegacyPropertyId,
    resolveShortUrl,
} from './resolvers.js';
import { detectExpediaSite,EXPEDIA_SITE_CONFIGS, VRBO_SITE_CONFIGS } from './site-configs.js';
import type { PropertyResult } from './types.js';
import {
    detectPlatform,
    extractPropertyId,
    extractVrboPropertyId,
} from './url-parser.js';

/** Which fingerprint a client needs: GraphQL/okhttp4 vs Hotels.com HTML/chrome. */
export type ClientKind = 'graphql' | 'html';

export interface ScrapeDeps {
    /**
     * Produce an HttpClient for this URL's sticky session/IP. `kind` selects the
     * fingerprint (graphql→okhttp4, html→chrome). In tests this returns a fake.
     */
    makeClient(kind?: ClientKind): HttpClient;
}

/** Run all five GraphQL fetches in parallel and format the result. */
async function fetchAndFormat(
    client: PropertyClient,
    propertyId: string,
    url: string,
): Promise<PropertyResult> {
    const [summaryData, contentData, galleryData, offersData, pageLayoutData] = await Promise.all([
        client.fetchPropertySummary(propertyId),
        client.fetchPropertyDetails(propertyId),
        client.fetchProductGallery(propertyId),
        client.fetchPropertyOffers(propertyId),
        client.fetchPageLayout(propertyId),
    ]);
    return formatProperty({ summaryData, contentData, url, propertyId, galleryData, offersData, pageLayoutData });
}

async function scrapeVrbo(url: string, deps: ScrapeDeps): Promise<PropertyResult> {
    // Always scrape via vrbo.com — regional endpoints can return wrong data.
    const [propertyId, suffix] = extractVrboPropertyId(url);
    if (!propertyId) throw new URLParseError(`Could not extract property ID from VRBO URL: ${url}`);

    const http = deps.makeClient('graphql');
    const resolvedId = await resolveLegacyPropertyId(url, propertyId, suffix ?? '', http);

    const client = new PropertyClient({ profile: makeVrboProfile(), site: VRBO_SITE_CONFIGS['vrbo.com'], http });
    return fetchAndFormat(client, resolvedId, url);
}

async function scrapeExpedia(url: string, deps: ScrapeDeps): Promise<PropertyResult> {
    const siteKey = detectExpediaSite(url) ?? 'expedia.com';
    const site = EXPEDIA_SITE_CONFIGS[siteKey];
    const [propertyId] = extractPropertyId(url);
    if (!propertyId) throw new URLParseError(`Could not extract property ID from Expedia URL: ${url}`);

    const http = deps.makeClient('graphql');
    const client = new PropertyClient({ profile: makeExpediaProfile(site), site, http });
    return fetchAndFormat(client, propertyId, url);
}

async function scrapeHotels(url: string, deps: ScrapeDeps): Promise<PropertyResult> {
    // Hotels.com uses different ids than Expedia — convert via the page HTML.
    const htmlHttp = deps.makeClient('html');
    const expediaId = await convertHotelsComToExpedia(url, htmlHttp);
    if (!expediaId) throw new URLParseError(`Could not convert Hotels.com URL to Expedia property ID: ${url}`);

    // Scrape via the Expedia endpoint (hotels.com/graphql soft-blocks through
    // residential proxies). The output source stays "Hotels.com" since it derives
    // from `url`.
    const site = EXPEDIA_SITE_CONFIGS['expedia.com'];
    const http = deps.makeClient('graphql');
    const client = new PropertyClient({ profile: makeExpediaProfile(site), site, http });
    return fetchAndFormat(client, expediaId, url);
}

/**
 * Scrape one Property URL into a single success row. Throws on failure (the
 * caller turns that into the one error row). Auto-detects the platform.
 */
export async function scrapeProperty(rawUrl: string, deps: ScrapeDeps): Promise<PropertyResult> {
    const url = await resolveShortUrl(rawUrl, deps.makeClient('graphql'));
    const platform = detectPlatform(url);

    if (platform === 'vrbo') return scrapeVrbo(url, deps);
    if (platform === 'expedia') return scrapeExpedia(url, deps);
    if (platform === 'hotels.com') return scrapeHotels(url, deps);
    throw new URLParseError(`Unsupported platform for URL: ${url}`);
}
