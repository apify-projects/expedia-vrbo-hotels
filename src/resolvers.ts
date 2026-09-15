/**
 * Pure parsing for the pages the crawler fetches on the way to a Property ID:
 *  - short links (t.vrbo.io) and Branch.io deep links -> the final property URL;
 *  - a legacy HomeAway page -> the internal VRBO Property ID;
 *  - a Hotels.com page -> the Expedia Property ID.
 *
 * The embedded-JSON / og:image / frequency-counted patterns stay as regex on
 * purpose: they read minified app state and pick the most frequent id, which a
 * DOM parser cannot reproduce.
 */
import * as cheerio from 'cheerio';

import { HotelsComDelistedError, PropertyNotFoundError } from './errors.js';
import { VRBO_SITE_CONFIGS } from './site-configs.js';

const SHORT_URL_HOSTS = new Set(['t.vrbo.io', 'vrbo.io', 't.expedia.com', 't.hotels.com']);
const DEEP_LINK_HOSTS = new Set(['expe.app.link', 'hotels.app.link']);

// Hosts that mark a final property URL (stop following redirects here).
const FINAL_HOST_HINTS = ['vrbo.com', 'expedia', 'hotels.com', ...Object.keys(VRBO_SITE_CONFIGS)];

export const MOBILE_BROWSER_UA =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36';

export const HOMEAWAY_HTML_HEADERS = {
    'User-Agent': 'HomeAway/2025.47.0 Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
};

export const HOTELS_COM_HEADERS = {
    'User-Agent': 'HCom/2025.46.0 Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
};

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function looksFinal(url: string): boolean {
    return FINAL_HOST_HINTS.some((hint) => url.includes(hint));
}

/** True if the URL is a short link or Branch.io deep link needing resolution. */
export function isResolvableUrl(url: string): boolean {
    if (!url.startsWith('http')) return false;
    const host = hostnameOf(url);
    if (SHORT_URL_HOSTS.has(host) || DEEP_LINK_HOSTS.has(host)) return true;
    return url.includes('homeaway.com/vl');
}

/** Only `/p<id>` paths and the `ha` suffix carry legacy ids the API rejects. */
export function needsIdResolution(url: string, suffix: string): boolean {
    if (suffix === 'vb') return false;
    return suffix === 'ha' || /\/p\d+/i.test(url);
}

/**
 * Where a short link actually went. `loadedUrl` is the landing page after
 * redirects; Branch.io serves an interstitial instead, so fall back to the
 * destination it embeds. Null when neither yields a property URL.
 */
export function findDestinationUrl(loadedUrl: string, html: string): string | null {
    if (looksFinal(loadedUrl) && !isResolvableUrl(loadedUrl)) return loadedUrl;

    const fallback = /browser_fallback_url=([^&"'>\s]+)/.exec(html);
    if (fallback) {
        const decoded = decodeURIComponent(fallback[1]);
        if (looksFinal(decoded)) return decoded;
    }
    const embedded = /https?:\/\/(?:www\.)?(?:vrbo\.com|expedia\.com|hotels\.com)\/[^\s"'<>]+/.exec(html);
    if (embedded) return embedded[0].replace(/\\+$/, '');

    return null;
}

/**
 * Vrbo sends a dead listing to the homepage or an area search page, where any id
 * on the page belongs to a region rather than to this property.
 */
export function assertVrboDetailPage(loadedUrl: string, propertyId: string): void {
    if (!loadedUrl.includes(propertyId)) {
        throw new PropertyNotFoundError(`Vrbo listing ${propertyId} no longer exists`);
    }
}

/** The internal VRBO Property ID from a legacy listing page; the input id if absent. */
export function findVrboPropertyId(html: string, propertyId: string): string {
    // 1. og:image lodging path: /lodging/118000000/117900000/117899000/117898910/image.jpg
    let match = /\/lodging\/\d+\/\d+\/\d+\/(\d+)\//.exec(html);
    if (match && match[1] !== propertyId) return match[1];

    const $ = cheerio.load(html);

    // 2. <meta itemprop="identifier" content="..."> (either attribute order)
    const metaId = $('meta[itemprop="identifier"]').attr('content');
    if (metaId && /^\d+$/.test(metaId)) return metaId;

    // 3. "propertyId":"117898910" in embedded JSON
    match = /"propertyId"\s*:\s*"(\d+)"/.exec(html);
    if (match && match[1] !== propertyId) return match[1];

    // 4. data-property-id="117898910"
    const dataId = $('[data-property-id]').attr('data-property-id');
    if (dataId && /^\d+$/.test(dataId) && dataId !== propertyId) return dataId;

    // 5. canonical / og:url href ending in a different id
    match = /(?:canonical|og:url)[^>]*href=["'][^"']*?\/(\d+)(?:["']|[?/])/.exec(html);
    if (match && match[1] !== propertyId && match[1].length >= 6) return match[1];

    return propertyId;
}

/** Most frequent item; ties resolve to the first-seen value. */
function mostCommon(items: string[]): string {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    let best = items[0];
    let bestCount = -1;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return best;
}

/** Cheap path: Expedia id already present in the Hotels.com URL query string. */
export function extractExpediaIdFromUrl(hotelsComUrl: string): string | null {
    let params: URLSearchParams;
    try {
        params = new URL(hotelsComUrl).searchParams;
    } catch {
        return null;
    }
    for (const key of ['expediaPropertyId', 'selected']) {
        const value = params.get(key);
        if (value && /^\d+$/.test(value)) return value;
    }
    return null;
}

/**
 * Hotels.com 301s delisted or unknown ids to the homepage or a region page. If
 * the request named a /ho<id> property but the landing URL no longer does, it is
 * gone. Call only once the body is known good, so a block cannot look like a
 * delisting.
 */
export function assertHotelsComListed(requestUrl: string, loadedUrl: string): void {
    const pathOf = (url: string) => {
        try {
            return new URL(url).pathname;
        } catch {
            return '';
        }
    };
    const requested = /\/ho\d+/.exec(pathOf(requestUrl));
    if (!requested) return;
    if (/\/ho\d+/.test(pathOf(loadedUrl))) return;

    throw new HotelsComDelistedError(
        `Hotels.com no longer lists this property (ID ${requested[0].replace(/^[/ho]+/, '')}); `
        + `${requestUrl} redirected to ${loadedUrl}`,
    );
}

/** The Expedia Property ID embedded in a Hotels.com page; null when absent. */
export function findExpediaIdInHtml(html: string): string | null {
    // 0. Clean meta tag (case-sensitive itemProp, rendered on every property page).
    let matches = [...html.matchAll(/itemProp=["']identifier["'][^>]*content=["'](\d+)/g)];
    if (matches.length) return matches[0][1];

    // product_details?productId=615323 — appears many times in embedded state.
    matches = [...html.matchAll(/productId[\\"']*[:=][\\"']*(\d+)/g)];
    if (matches.length) return mostCommon(matches.map((m) => m[1]));

    // expediaPropertyId (allows backslash-escaped JSON quotes).
    matches = [...html.matchAll(/expediaPropertyId[\\"']*\s*[:=]\s*[\\"']*(\d+)/g)];
    if (matches.length) return matches[0][1];

    // JSON-LD structured data (first 3 blocks).
    const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .slice(0, 3);
    for (const block of ldBlocks) {
        try {
            const data = JSON.parse(block);
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                for (const key of ['identifier', '@id', 'propertyId']) {
                    const value = data[key];
                    if (typeof value === 'string' || typeof value === 'number') {
                        const text = String(value);
                        if (/^\d+$/.test(text)) return text;
                    }
                }
            }
        } catch {
            // not valid JSON, skip
        }
    }

    // propertyId in JS state → most common.
    matches = [...html.matchAll(/propertyId["']?\s*[:=]\s*["']?(\d+)/g)];
    if (matches.length) return mostCommon(matches.map((m) => m[1]));

    // data-property-id attribute.
    matches = [...html.matchAll(/data-property-id=["'](\d+)["']/g)];
    if (matches.length) return matches[0][1];

    // meta name/property property-id.
    matches = [...html.matchAll(/<meta[^>]*(?:name|property)=["'](?:expedia:)?property[_-]?id["'][^>]*content=["'](\d+)["']/gi)];
    if (matches.length) return matches[0][1];

    // hotelId / propertyId / property_id → most common.
    matches = [...html.matchAll(/(?:propertyId|hotelId|property_id)["']?\s*[:=]\s*["']?(\d+)/g)];
    if (matches.length) return mostCommon(matches.map((m) => m[1]));

    return null;
}
