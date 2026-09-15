/**
 * Pure parsing for the pages the crawler fetches on the way to a Property ID:
 *  - short links (t.vrbo.io) and Branch.io deep links -> the final property URL;
 *  - a legacy HomeAway page -> the internal Vrbo Property ID;
 *  - a Hotels.com page -> the Expedia Property ID.
 *
 * Both id readers start from `og:image`, whose path carries the id of the
 * property the page is actually about. The fallbacks read script contents, where
 * the id appears in minified app state that has no markup to select.
 */
import type { CheerioAPI } from 'crawlee';

import { HotelsComDelistedError, PropertyNotFoundError } from './errors.js';
import { VRBO_SITE_CONFIGS } from './site-configs.js';

const SHORT_URL_HOSTS = new Set(['t.vrbo.io', 'vrbo.io', 't.expedia.com', 't.hotels.com']);
const DEEP_LINK_HOSTS = new Set(['expe.app.link', 'hotels.app.link']);

// Hosts that mark a final property URL (stop following redirects here).
const FINAL_HOST_HINTS = ['vrbo.com', 'expedia', 'hotels.com', ...Object.keys(VRBO_SITE_CONFIGS)];

export const MOBILE_BROWSER_UA =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36';

export const HOMEAWAY_HTML_HEADERS = {
    'User-Agent':
        'HomeAway/2025.47.0 Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)',
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

/** `.../lodging/1000000/30000/21900/21856/photo.jpg` -> `21856`. */
function idFromLodgingPath(url: string | undefined): string | null {
    const match = /\/lodging\/\d+\/\d+\/\d+\/(\d+)\//.exec(url ?? '');
    return match ? match[1] : null;
}

/** The property's own image, so its id belongs to this page and not to a carousel. */
function idFromOgImage($: CheerioAPI): string | null {
    return idFromLodgingPath($('meta[property="og:image"]').attr('content'));
}

/** Everything the page runs as script, where the app state lives. */
function scriptText($: CheerioAPI): string {
    return $('script').text();
}

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
export function findDestinationUrl(loadedUrl: string, $: CheerioAPI): string | null {
    if (looksFinal(loadedUrl) && !isResolvableUrl(loadedUrl)) return loadedUrl;

    // A deep link puts its destination in a link, a meta refresh or its own
    // script state, so search each of those rather than the whole document.
    const places = [
        ...$('a[href]')
            .toArray()
            .map((link) => $(link).attr('href') ?? ''),
        $('meta[http-equiv="refresh"]').attr('content') ?? '',
        $.root().text(),
    ];

    for (const place of places) {
        const fallback = /browser_fallback_url=([^&"'>\s]+)/.exec(place);
        if (fallback) {
            const decoded = decodeURIComponent(fallback[1]);
            if (looksFinal(decoded)) return decoded;
        }
    }
    for (const place of places) {
        const embedded = /https?:\/\/(?:www\.)?(?:vrbo\.com|expedia\.com|hotels\.com)\/[^\s"'<>]+/.exec(place);
        if (embedded) return embedded[0].replace(/\\+$/, '');
    }

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

/** The internal Vrbo Property ID from a legacy listing page; the input id if absent. */
export function findVrboPropertyId($: CheerioAPI, propertyId: string): string {
    const fromImage = idFromOgImage($) ?? idFromLodgingPath($('img[src*="/lodging/"]').first().attr('src'));
    if (fromImage && fromImage !== propertyId) return fromImage;

    const identifier = $('meta[itemprop="identifier"]').attr('content');
    if (identifier && /^\d+$/.test(identifier)) return identifier;

    const embedded = /"propertyId"\s*:\s*"(\d+)"/.exec(scriptText($))?.[1];
    if (embedded && embedded !== propertyId) return embedded;

    const dataId = $('[data-property-id]').attr('data-property-id');
    if (dataId && /^\d+$/.test(dataId) && dataId !== propertyId) return dataId;

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
        `Hotels.com no longer lists this property (ID ${requested[0].replace(/^[/ho]+/, '')}); ` +
            `${requestUrl} redirected to ${loadedUrl}`,
    );
}

/** The Expedia Property ID a Hotels.com page is about; null when absent. */
export function findExpediaId($: CheerioAPI): string | null {
    const fromImage = idFromOgImage($) ?? idFromLodgingPath($('img[src*="/lodging/"]').first().attr('src'));
    if (fromImage) return fromImage;

    const identifier = $('meta[itemprop="identifier"]').attr('content');
    if (identifier && /^\d+$/.test(identifier)) return identifier;

    for (const block of $('script[type="application/ld+json"]').slice(0, 3)) {
        let data: Record<string, unknown>;
        try {
            data = JSON.parse($(block).text());
        } catch {
            continue;
        }
        for (const key of ['identifier', '@id', 'propertyId']) {
            const value = data[key];
            if ((typeof value === 'string' || typeof value === 'number') && /^\d+$/.test(String(value))) {
                return String(value);
            }
        }
    }

    // The app state names the property many times over and other ids once or
    // twice, so the most frequent id is the page's own.
    const scripts = scriptText($);
    for (const pattern of [
        /productId[\\"']*[:=][\\"']*(\d+)/g,
        /expediaPropertyId[\\"']*\s*[:=]\s*[\\"']*(\d+)/g,
        /(?:propertyId|hotelId|property_id)["']?\s*[:=]\s*["']?(\d+)/g,
    ]) {
        const ids = [...scripts.matchAll(pattern)].map((match) => match[1]);
        if (ids.length) return mostCommon(ids);
    }

    const dataId = $('[data-property-id]').attr('data-property-id');
    return dataId && /^\d+$/.test(dataId) ? dataId : null;
}
