/**
 * Actor entry point.
 *
 * One input URL becomes one queue entry, routed by Platform, producing exactly
 * one dataset item: the routes push success items, the failedRequestHandler pushes
 * error items. The crawler owns the HTTP client, proxy, session pool and retries;
 * handlers reach the GraphQL endpoint through `context.sendRequest`, so all of a
 * property's calls share that request's sticky residential IP.
 */
import { ImpitHttpClient } from '@crawlee/impit-client';
import { Actor } from 'apify';
import { CheerioCrawler, type CheerioCrawlingContext, log } from 'crawlee';

import { formatError } from './formatter.js';
import { buildStartRequests } from './input.js';
import { router } from './routes.js';
import { detectPlatform, extractPropertyId, extractVrboPropertyId, type Platform } from './url-parser.js';

interface ActorInput {
    urls: string[];
}

/** Best-effort id + Platform tag for an error item. */
function errorItemMeta(url: string): { id: string; platform: Platform | null } {
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

const { requests, unusable, duplicateCount } = buildStartRequests(urls);

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

const crawler = new CheerioCrawler({
    proxyConfiguration,
    // The Mobile GraphQL API rejects default TLS fingerprints.
    httpClient: new ImpitHttpClient({ browser: 'okhttp4', ignoreTlsErrors: true }),
    requestHandler: router,
    // Five parallel GraphQL calls plus an optional page fetch; the default 60s
    // aborts slow proxies.
    requestHandlerTimeoutSecs: 180,

    // Single source of every error item → preserves the one-item-per-URL invariant.
    // Crawlee already logs the failure itself, so this only writes the item.
    async failedRequestHandler({ request }: CheerioCrawlingContext, error: Error) {
        const { id, platform } = errorItemMeta(request.url);
        await Actor.pushData(formatError(request.url, id, error.message, platform));
    },
});

// RequestQueue dedups by URL and persists handled requests across abort/migration,
// so a resurrected run skips already-scraped Properties for free.
await crawler.run(requests);

await Actor.exit();
