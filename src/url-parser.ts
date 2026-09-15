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
        throw new URLParseError(`Could not extract property ID from Expedia URL: ${url}`);
    }

    if (domain.includes('hotels.com')) {
        let m = /\/ho(\d+)\//.exec(url);
        if (m) return [m[1], 'hotels.com'];
        m = /\/ho(\d+)/.exec(url);
        if (m) return [m[1], 'hotels.com'];
        throw new URLParseError(`Could not extract property ID from Hotels.com URL: ${url}`);
    }

    if (
        domain.includes('vrbo') ||
        domain.includes('homeaway') ||
        domain.includes('abritel') ||
        domain.includes('fewo-direkt') ||
        domain.includes('bookabach') ||
        domain.includes('stayz')
    ) {
        let m = /\/rental\/(\d+)/.exec(url);
        if (m) return [m[1], 'vrbo'];
        m = /\/p(\d+)[a-z]*(?:\/|$|\?)/i.exec(url);
        if (m) return [m[1], 'vrbo'];
        m = /\/(\d+)/.exec(url);
        if (m) return [m[1], 'vrbo'];
        throw new URLParseError(`Could not extract property ID from Vrbo URL: ${url}`);
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
