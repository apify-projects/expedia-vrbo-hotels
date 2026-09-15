/**
 * URL/ID resolvers that need an HTML prefetch:
 *  - resolveShortUrl: short links (t.vrbo.io) and Branch.io deep links
 *    (expe.app.link, hotels.app.link) → final property URL.
 *  - resolveLegacyPropertyId: legacy HomeAway id → internal VRBO Property ID.
 *  - convertHotelsComToExpedia: Hotels.com URL → Expedia Property ID.
 *
 * Faithful ports of `main.py`, `clients/vrbo_client.py` and
 * `hotels_com_converter.py`. Two deliberate changes from the Python, both
 * required by the PRD:
 *  1. The Google-DoH + socket.getaddrinfo deep-link hack is DELETED; redirects
 *     are followed through the residential proxy (remote DNS) via impit.
 *  2. Cheerio parses the structurally-addressable bits (meta itemprop, data
 *     attributes). The embedded-JSON / og:image / frequency-counted patterns
 *     stay as faithful regex on purpose: they read minified app state and pick
 *     the *most frequent* id, which a DOM parser cannot reproduce — changing
 *     them would break output parity (the stated goal).
 */
import * as cheerio from 'cheerio';

import { BlockedResponseError, HotelsComDelistedError, PropertyNotFoundError } from './errors.js';
import type { HttpClient } from './http/http-client.js';
import { VRBO_SITE_CONFIGS } from './site-configs.js';

const SHORT_URL_HOSTS = new Set(['t.vrbo.io', 'vrbo.io', 't.expedia.com', 't.hotels.com']);
const DEEP_LINK_HOSTS = new Set(['expe.app.link', 'hotels.app.link']);

// Hosts that mark a *final* property URL (stop following redirects here).
const FINAL_HOST_HINTS = ['vrbo.com', 'expedia', 'hotels.com', ...Object.keys(VRBO_SITE_CONFIGS)];

const MOBILE_BROWSER_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36';

const HOMEAWAY_HTML_HEADERS = {
    'User-Agent': 'HomeAway/2025.47.0 Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
};

const HOTELS_COM_HEADERS = {
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

function looksFinal(u: string): boolean {
    return FINAL_HOST_HINTS.some((t) => u.includes(t));
}

/** True if the URL is a short link or Branch.io deep link needing resolution. */
export function isResolvableUrl(url: string): boolean {
    if (!url.startsWith('http')) return false;
    const host = hostnameOf(url);
    if (SHORT_URL_HOSTS.has(host) || DEEP_LINK_HOSTS.has(host)) return true;
    return url.includes('homeaway.com/vl');
}

/**
 * Follow short links / deep links (through the proxy) to the final property URL.
 * Returns the original URL unchanged if it is not a short/deep link, or if no
 * destination can be found.
 */
export async function resolveShortUrl(url: string, http: HttpClient): Promise<string> {
    if (!isResolvableUrl(url)) return url;

    let current = url;
    for (let hop = 0; hop < 6; hop++) {
        let resp;
        try {
            resp = await http.fetch(current, {
                method: 'GET',
                redirect: 'manual',
                headers: { 'User-Agent': MOBILE_BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
            });
        } catch {
            break;
        }

        if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.header('Location') ?? resp.header('location');
            if (!loc) break;
            if (looksFinal(loc)) return loc;
            current = loc; // follow intermediary (app.link / branch.io)
            continue;
        }

        if (resp.status === 200) {
            const html = await resp.text();
            const fb = /browser_fallback_url=([^&"'>\s]+)/.exec(html);
            if (fb) {
                const decoded = decodeURIComponent(fb[1]);
                if (looksFinal(decoded)) return decoded;
            }
            const m = /https?:\/\/(?:www\.)?(?:vrbo\.com|expedia\.com|hotels\.com)\/[^\s"'<>]+/.exec(html);
            if (m) return m[0].replace(/\\+$/, '');
        }
        break;
    }
    return url;
}

/** Only `/p<id>` paths and the `ha` suffix carry legacy ids the API rejects. */
function needsIdResolution(url: string, suffix: string): boolean {
    return suffix === 'ha' || /\/p\d+/i.test(url);
}

/**
 * Resolve a legacy HomeAway property id to the internal VRBO Property ID by
 * reading the listing page. 'vb' (native VRBO) ids need no resolution.
 */
export async function resolveLegacyPropertyId(
    url: string,
    propertyId: string,
    suffix: string,
    http: HttpClient,
): Promise<string> {
    if (suffix === 'vb') return propertyId;
    // Bare numeric and /pdp/lo/ urls already carry a Property ID; fetching their
    // page just downloads the Vrbo homepage.
    if (!needsIdResolution(url, suffix)) return propertyId;

    const fetchUrl = url.startsWith('http') ? url : `https://www.vrbo.com/${propertyId}${suffix}`;
    const resp = await http.fetch(fetchUrl, { method: 'GET', redirect: 'follow', headers: HOMEAWAY_HTML_HEADERS });
    const html = await resp.text();

    // Vrbo sends a dead listing to the homepage or an area search page. Ids
    // scraped off those belong to a region, not to this property.
    if (!resp.url.includes(propertyId)) {
        throw new PropertyNotFoundError(`Vrbo listing ${propertyId} no longer exists`);
    }

    // 1. og:image lodging path: /lodging/118000000/117900000/117899000/117898910/image.jpg
    let m = /\/lodging\/\d+\/\d+\/\d+\/(\d+)\//.exec(html);
    if (m && m[1] !== propertyId) return m[1];

    const $ = cheerio.load(html);

    // 2. <meta itemprop="identifier" content="..."> (either attribute order)
    const metaId = $('meta[itemprop="identifier"]').attr('content');
    if (metaId && /^\d+$/.test(metaId)) return metaId;

    // 3. "propertyId":"117898910" in embedded JSON
    m = /"propertyId"\s*:\s*"(\d+)"/.exec(html);
    if (m && m[1] !== propertyId) return m[1];

    // 4. data-property-id="117898910"
    const dataId = $('[data-property-id]').attr('data-property-id');
    if (dataId && /^\d+$/.test(dataId) && dataId !== propertyId) return dataId;

    // 5. canonical / og:url href ending in a different id
    m = /(?:canonical|og:url)[^>]*href=["'][^"']*?\/(\d+)(?:["']|[?/])/.exec(html);
    if (m && m[1] !== propertyId && m[1].length >= 6) return m[1];

    return propertyId;
}

/** Most frequent item; ties resolve to the first-seen value (matches Counter.most_common). */
function mostCommon(items: string[]): string {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it, (counts.get(it) ?? 0) + 1);
    let best = items[0];
    let bestN = -1;
    for (const [k, n] of counts) {
        if (n > bestN) {
            best = k;
            bestN = n;
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
        const v = params.get(key);
        if (v && /^\d+$/.test(v)) return v;
    }
    return null;
}

/**
 * Fetch the Hotels.com page. Blocks throw BlockedResponseError so the retry gets
 * a fresh IP; only a page that actually loaded reaches the id patterns.
 */
async function fetchHotelsComPage(hotelsComUrl: string, http: HttpClient): Promise<string> {
    let resp;
    try {
        resp = await http.fetch(hotelsComUrl, { method: 'GET', redirect: 'follow', headers: HOTELS_COM_HEADERS });
    } catch (e) {
        throw new Error(`Hotels.com page fetch failed for ${hotelsComUrl}: ${(e as Error).message}`);
    }

    if (resp.status === 403 || resp.status === 429) {
        throw new BlockedResponseError(`HTTP ${resp.status} block fetching ${hotelsComUrl}`);
    }
    if (resp.status >= 400) {
        throw new Error(`HTTP ${resp.status} fetching ${hotelsComUrl}`);
    }

    const html = await resp.text();
    if (!html.trim()) {
        throw new BlockedResponseError(`Empty body from ${hotelsComUrl} (HTTP ${resp.status}) — soft-block`);
    }

    // Hotels.com 301s delisted/unknown ids to the homepage/region page. If the
    // original named a /ho<id> property but the final URL no longer does, it's gone.
    // After the empty-body check, so a block can't look like a delisting.
    const origPath = (() => { try { return new URL(hotelsComUrl).pathname; } catch { return ''; } })();
    const origMatch = /\/ho\d+/.exec(origPath);
    if (origMatch) {
        const finalPath = (() => { try { return new URL(resp.url).pathname; } catch { return ''; } })();
        if (!/\/ho\d+/.test(finalPath)) {
            throw new HotelsComDelistedError(
                `Hotels.com no longer lists this property (ID ${origMatch[0].replace(/^[/ho]+/, '')}); `
                + `${hotelsComUrl} redirected to ${resp.url}`,
            );
        }
    }

    return html;
}

/**
 * Extract the Expedia Property ID from a Hotels.com page's HTML / embedded JS.
 * Returns null only when the page loaded and has no id in it.
 */
export async function extractExpediaIdFromHtml(hotelsComUrl: string, http: HttpClient): Promise<string | null> {
    const html = await fetchHotelsComPage(hotelsComUrl, http);

    // 0. Clean meta tag (case-sensitive itemProp, rendered on every property page).
    let mm = [...html.matchAll(/itemProp=["']identifier["'][^>]*content=["'](\d+)/g)];
    if (mm.length) return mm[0][1];

    // product_details?productId=615323 — appears many times in embedded state.
    mm = [...html.matchAll(/productId[\\"']*[:=][\\"']*(\d+)/g)];
    if (mm.length) return mostCommon(mm.map((x) => x[1]));

    // expediaPropertyId (allows backslash-escaped JSON quotes).
    mm = [...html.matchAll(/expediaPropertyId[\\"']*\s*[:=]\s*[\\"']*(\d+)/g)];
    if (mm.length) return mm[0][1];

    // JSON-LD structured data (first 3 blocks).
    const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)]
        .map((x) => x[1])
        .slice(0, 3);
    for (const block of ldBlocks) {
        try {
            const data = JSON.parse(block);
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                for (const key of ['identifier', '@id', 'propertyId']) {
                    const val = data[key];
                    if (typeof val === 'string' || typeof val === 'number') {
                        const v = String(val);
                        if (/^\d+$/.test(v)) return v;
                    }
                }
            }
        } catch {
            // not valid JSON, skip
        }
    }

    // propertyId in JS state → most common.
    mm = [...html.matchAll(/propertyId["']?\s*[:=]\s*["']?(\d+)/g)];
    if (mm.length) return mostCommon(mm.map((x) => x[1]));

    // data-property-id attribute.
    mm = [...html.matchAll(/data-property-id=["'](\d+)["']/g)];
    if (mm.length) return mm[0][1];

    // meta name/property property-id.
    mm = [...html.matchAll(/<meta[^>]*(?:name|property)=["'](?:expedia:)?property[_-]?id["'][^>]*content=["'](\d+)["']/gi)];
    if (mm.length) return mm[0][1];

    // hotelId / propertyId / property_id → most common.
    mm = [...html.matchAll(/(?:propertyId|hotelId|property_id)["']?\s*[:=]\s*["']?(\d+)/g)];
    if (mm.length) return mostCommon(mm.map((x) => x[1]));

    return null;
}

/** Hotels.com URL → Expedia Property ID (cheap URL path first, then HTML). */
export async function convertHotelsComToExpedia(hotelsComUrl: string, http: HttpClient): Promise<string | null> {
    const fromUrl = extractExpediaIdFromUrl(hotelsComUrl);
    if (fromUrl) return fromUrl;
    return extractExpediaIdFromHtml(hotelsComUrl, http);
}
