/**
 * Turns the input URLs into crawler requests: accepts what a user pasted,
 * discards what cannot be a property URL, and drops duplicates.
 */
import { Request, type Source } from 'crawlee';

import { isResolvableUrl, MOBILE_BROWSER_UA } from './resolvers.js';
import { buildPropertyRequest, LABELS } from './routes.js';
import { extractPropertyId } from './url-parser.js';

export interface BuiltStartRequests {
    requests: Source[];
    /** One entry per input that cannot be scraped, with the reason to report. */
    unusable: { raw: string; reason: string }[];
    duplicateCount: number;
}

/**
 * Accept a pasted URL, adding the scheme when it is missing. Returns null when
 * the entry cannot be a property URL at all.
 */
export function parseInputUrl(raw: string): string | null {
    const trimmed = raw.trim();
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const { protocol, hostname, href } = new URL(candidate);
        if (protocol !== 'http:' && protocol !== 'https:') return null;
        return hostname === '' ? null : href;
    } catch {
        return null;
    }
}

export function buildStartRequests(urls: string[]): BuiltStartRequests {
    const requests: Source[] = [];
    const unusable: BuiltStartRequests['unusable'] = [];
    const seenKeys = new Set<string>();
    let duplicateCount = 0;

    for (const raw of urls) {
        const url = parseInputUrl(raw);
        if (url === null) {
            unusable.push({ raw, reason: 'Not a valid URL. Expected an absolute http(s) URL.' });
            continue;
        }
        // Crawlee would collapse these into one request on its own; dropping them
        // here keeps the reported counts honest.
        const key = Request.computeUniqueKey({ url, method: 'GET' });
        if (seenKeys.has(key)) {
            duplicateCount += 1;
            continue;
        }
        seenKeys.add(key);

        // A short link has to be followed before its Platform is known.
        if (isResolvableUrl(url)) {
            requests.push({ url, label: LABELS.SHORT_LINK, headers: { 'User-Agent': MOBILE_BROWSER_UA } });
            continue;
        }
        // extractPropertyId distinguishes an unsupported domain from a supported one
        // that is not a property page; detectPlatform would flatten both to null.
        try {
            const [, platform] = extractPropertyId(url);
            requests.push(buildPropertyRequest(url, platform));
        } catch (error) {
            unusable.push({ raw, reason: (error as Error).message });
        }
    }

    return { requests, unusable, duplicateCount };
}
