/**
 * URL parsing and platform detection for Expedia, Hotels.com, and Vrbo.
 *
 * The regexes and the order they are tried in are load-bearing: several URL
 * shapes match more than one pattern, so reordering the branches changes which id
 * wins.
 */
import { URLParseError } from './errors.js';

export type Platform = 'expedia' | 'hotels.com' | 'vrbo';

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        // Mirror urlparse's permissiveness: no host rather than throwing here.
        return '';
    }
}

/** Numeric-only id (strips any non-digit), matching Python's isdigit filter. */
export function numericId(id: string): string {
    return String(id).replace(/\D/g, '');
}

/**
 * The Property ID a URL carries in its query string. Expedia Group puts the
 * canonical id there on links it generates, and it is authoritative: a Vrbo path
 * id like `/716876` can be an older id the API rejects, while its
 * `expediaPropertyId` resolves.
 */
export function findPropertyIdInQuery(url: string): string | null {
    let params: URLSearchParams;
    try {
        params = new URL(url).searchParams;
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
 * Last resort for a URL whose path names no property. A search page opened on one
 * card carries that property in the query (`selected`), and it is the property
 * the user was looking at, so honour it. A search page with nothing selected
 * names no property at all and is rejected as one.
 */
function propertyIdFromQuery(url: string, site: string, platform: Platform): [string, Platform] {
    const queryId = findPropertyIdInQuery(url);
    if (queryId) return [queryId, platform];

    let path: string;
    try {
        path = new URL(url).pathname;
    } catch {
        path = url;
    }
    if (/search|results/i.test(path)) {
        throw new URLParseError(
            `${site} search pages work only with one property selected, otherwise paste a property page: ${url}`,
        );
    }
    throw new URLParseError(`Could not extract property ID from ${site} URL: ${url}`);
}

/**
 * Extract [propertyId, platform] from an Expedia/Hotels.com/Vrbo URL.
 * Throws URLParseError if the URL/domain is unsupported.
 */
export function extractPropertyId(url: string): [string, Platform] {
    if (!url || typeof url !== 'string') {
        throw new URLParseError(`Invalid URL: ${url}`);
    }

    const domain = hostnameOf(url);

    if (domain.includes('expedia')) {
        let m = /[./]h(\d+)\./.exec(url);
        if (m) return [m[1], 'expedia'];
        m = /\.h(\d+)/.exec(url);
        if (m) return [m[1], 'expedia'];
        return propertyIdFromQuery(url, 'Expedia', 'expedia');
    }

    if (domain.includes('hotels.com')) {
        let m = /\/ho(\d+)\//.exec(url);
        if (m) return [m[1], 'hotels.com'];
        m = /\/ho(\d+)/.exec(url);
        if (m) return [m[1], 'hotels.com'];
        return propertyIdFromQuery(url, 'Hotels.com', 'hotels.com');
    }

    if (
        domain.includes('vrbo') ||
        domain.includes('homeaway') ||
        domain.includes('abritel') ||
        domain.includes('fewo-direkt') ||
        domain.includes('bookabach') ||
        domain.includes('stayz')
    ) {
        const queryId = findPropertyIdInQuery(url);
        if (queryId) return [queryId, 'vrbo'];
        let m = /\/rental\/(\d+)/.exec(url);
        if (m) return [m[1], 'vrbo'];
        m = /\/p(\d+)[a-z]*(?:\/|$|\?)/i.exec(url);
        if (m) return [m[1], 'vrbo'];
        m = /\/(\d+)/.exec(url);
        if (m) return [m[1], 'vrbo'];
        return propertyIdFromQuery(url, 'Vrbo', 'vrbo');
    }

    throw new URLParseError(`Unsupported domain: ${domain}`);
}

/** True if the URL is a parseable property URL. */
export function validateUrl(url: string): boolean {
    try {
        extractPropertyId(url);
        return true;
    } catch (e) {
        if (e instanceof URLParseError) return false;
        throw e;
    }
}

/** Detect platform from URL without extracting the ID; null if unrecognized. */
export function detectPlatform(url: string): Platform | null {
    try {
        return extractPropertyId(url)[1];
    } catch (e) {
        if (e instanceof URLParseError) return null;
        throw e;
    }
}

/**
 * Extract [numericId, suffix] from a Vrbo URL across its many formats.
 * Returns [null, null] when nothing matches. suffix is one of 'ha'|'vb'|'a'|''.
 * Faithful port of vrbo_client.extract_property_id_from_url.
 */
export function extractVrboPropertyId(url: string): [string, string] | [null, null] {
    const cleaned = url.trim().replace(/["']+$/, '');
    if (!cleaned.startsWith('http')) return [null, null];

    const queryId = findPropertyIdInQuery(cleaned);
    if (queryId) return [queryId, ''];

    let path: string;
    try {
        path = new URL(cleaned).pathname.replace(/^\/+|\/+$/g, '');
    } catch {
        return [null, null];
    }

    // Pattern 1: /p{ID}{suffix} anywhere in path
    let m = /\/p(\d+)([a-z]*)(?:\/|$|\?)/i.exec(`/${path}/`);
    if (m) {
        return [m[1], m[2] ? m[2].toLowerCase() : ''];
    }

    // Pattern 2: numeric ID with optional short suffix at a path boundary
    m = /(?:^|\/)(\d+)([a-z]{0,3})(?:\/|$)/i.exec(path);
    if (m) {
        return [m[1], m[2] ? m[2].toLowerCase() : ''];
    }

    return [null, null];
}
