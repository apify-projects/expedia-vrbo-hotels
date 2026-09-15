/**
 * Actor entry point.
 *
 * One input URL becomes one queue entry, routed by Platform, producing exactly
 * one dataset row: the routes push success rows, the failedRequestHandler pushes
 * error rows. HttpCrawler owns the HTTP client, proxy, session pool and retries;
 * handlers reach the GraphQL endpoint through `context.sendRequest`, so all of a
 * property's calls share that request's sticky residential IP.
 */
import { ImpitHttpClient } from '@crawlee/impit-client';
import { Actor } from 'apify';
import { HttpCrawler, type HttpCrawlingContext, log, Request } from 'crawlee';

import { formatError } from './formatter.js';
import { isResolvableUrl, MOBILE_BROWSER_UA } from './resolvers.js';
import { buildPropertyRequest, LABELS, router } from './routes.js';
import { detectPlatform, extractPropertyId, extractVrboPropertyId, type Platform } from './url-parser.js';

interface ActorInput {
    urls: string[];
}

/**
 * Accept a pasted URL, adding the scheme when it is missing. Returns null when
 * the entry cannot be a property URL at all.
 */
function parseInputUrl(raw: string): string | null {
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

/** Best-effort id + Platform tag for an error row. */
function errorRowMeta(url: string): { id: string; platform: Platform | null } {
    const platform = detectPlatform(url);
    if (!platform) return { id: 'unknown', platform: null };
    try {
        const extracted = platform === 'vrbo' ? extractVrboPropertyId(url)[0] : extractPropertyId(url)[0];
        return { id: extracted ?? 'unknown', platform };
    } catch {
        return { id: 'unknown', platform };
    }
}

await Actor.init();

const { urls } = await Actor.getInputOrThrow<ActorInput>();

const requests = [];
const unusable: { raw: string; reason: string }[] = [];
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

if (duplicateCount > 0) {
    log.warning(`Skipping ${duplicateCount} duplicate URLs`);
}
if (unusable.length > 0) {
    log.warning(`Skipping ${unusable.length} of ${urls.length} inputs that are not property URLs`);
    for (const { raw, reason } of unusable) {
        await Actor.pushData(formatError(raw, 'unknown', reason, null));
    }
}
if (requests.length === 0) {
    await Actor.fail(`None of the ${urls.length} input URLs are usable.`);
}

// The endpoint rejects datacenter IPs, so residential is not a user choice.
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    checkAccess: false,
});

const crawler = new HttpCrawler({
    proxyConfiguration,
    // The Mobile GraphQL API rejects default TLS fingerprints.
    httpClient: new ImpitHttpClient({ browser: 'okhttp4', ignoreTlsErrors: true }),
    requestHandler: router,
    // Five parallel GraphQL calls plus an optional page fetch; the default 60s
    // aborts slow proxies.
    requestHandlerTimeoutSecs: 180,

    // Single source of every error row → preserves the one-row-per-URL invariant.
    // Crawlee already logs the failure itself, so this only writes the row.
    async failedRequestHandler({ request }: HttpCrawlingContext, error: Error) {
        const { id, platform } = errorRowMeta(request.url);
        await Actor.pushData(formatError(request.url, id, error.message, platform));
    },
});

// RequestQueue dedups by URL and persists handled requests across abort/migration,
// so a resurrected run skips already-scraped Properties for free.
await crawler.run(requests);

await Actor.exit();
