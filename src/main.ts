/**
 * Actor entry point.
 *
 * BasicCrawler owns the queue, concurrency, retries and session pool (ADR-0002,
 * ADR-0003); impit does the HTTP inside the handler. One Property URL → one
 * Terminal row:
 *   - requestHandler pushes SUCCESS rows only;
 *   - a single failedRequestHandler pushes ALL error rows.
 * One sticky residential IP per URL (SessionPool session → proxyConfiguration
 * .newUrl(session.id)); the 5 GraphQL calls share it. An empty-body soft-block
 * retires the session so the retry lands a fresh IP.
 */
import { Actor } from 'apify';
import { BasicCrawler, type BasicCrawlingContext, log } from 'crawlee';

import { BlockedResponseError } from './errors.js';
import { formatError } from './formatter.js';
import { ImpitHttpClient } from './http/impit-client.js';
import type { ClientKind, ScrapeDeps } from './pipeline.js';
import { scrapeProperty } from './pipeline.js';
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

// Datacenter IPs are rejected
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    checkAccess: false,
});

const crawler = new BasicCrawler({
    // Default request handler timeout (60s) is generous for 5 parallel GraphQL
    // calls plus an optional HTML prefetch; raise it so slow proxies don't abort.
    requestHandlerTimeoutSecs: 180,

    async requestHandler({ request, session }: BasicCrawlingContext) {
        // One sticky residential IP per URL: bind the upstream to this session.
        const proxyUrl = await proxyConfiguration?.newUrl(session?.id);
        const makeClient: ScrapeDeps['makeClient'] = (kind: ClientKind = 'graphql') =>
            new ImpitHttpClient({ proxyUrl, browser: kind === 'html' ? 'chrome' : 'okhttp4' });

        try {
            const result = await scrapeProperty(request.url, { makeClient });
            await Actor.pushData(result); // success rows only
            log.info(`Scraped ${result.name} (${request.url})`);
        } catch (err) {
            // A soft-block (empty body) → retire the session so the retry rotates IP.
            if (err instanceof BlockedResponseError) session?.retire();
            throw err; // let Crawlee retry / route to failedRequestHandler
        }
    },

    // Single source of every error row → preserves the one-row-per-URL invariant.
    // Crawlee already logs the failure itself, so this only writes the row.
    async failedRequestHandler({ request }: BasicCrawlingContext, error: Error) {
        const { id, platform } = errorRowMeta(request.url);
        await Actor.pushData(formatError(request.url, id, error.message, platform));
    },
});

const usableUrls: string[] = [];
const invalidUrls: string[] = [];
for (const raw of urls) {
    const url = parseInputUrl(raw);
    if (url === null) invalidUrls.push(raw);
    else usableUrls.push(url);
}

if (invalidUrls.length > 0) {
    log.warning(`Skipping ${invalidUrls.length} of ${urls.length} inputs that are not valid URLs`);
    for (const raw of invalidUrls) {
        await Actor.pushData(formatError(raw, 'unknown', 'Not a valid URL. Expected an absolute http(s) URL.', null));
    }
}
if (usableUrls.length === 0) {
    await Actor.fail(`None of the ${urls.length} input URLs are valid.`);
}

log.info(`Processing ${usableUrls.length} URLs`);
// RequestQueue dedups by URL and persists handled requests across abort/migration,
// so a resurrected run skips already-scraped Properties for free (ADR-0003).
await crawler.run(usableUrls);

await Actor.exit();
