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

import { BlockedResponseError, HotelsComDelistedError } from './errors.js';
import { formatError } from './formatter.js';
import { ImpitHttpClient } from './http/impit-client.js';
import type { ClientKind, ScrapeDeps } from './pipeline.js';
import { scrapeProperty } from './pipeline.js';
import { detectPlatform, extractPropertyId, extractVrboPropertyId } from './url-parser.js';

interface ActorInput {
    urls?: string[] | string;
    url?: string;
    proxyConfiguration?: Record<string, unknown>;
    maxConcurrency?: number;
    /** Back-compat alias for Crawlee's maxRequestRetries. */
    maxRetries?: number;
    maxRequestRetries?: number;
}

/** Best-effort id + Platform tag for an error row, matching main.py's error paths. */
function errorRowMeta(url: string, error: unknown): { id: string; platform: string } {
    let id = 'unknown';
    try {
        const plat = detectPlatform(url);
        const extracted = plat === 'vrbo' ? extractVrboPropertyId(url)[0] : extractPropertyId(url)[0];
        id = extracted ?? 'unknown';
    } catch {
        // leave id as 'unknown'
    }
    // Python tags delisted Hotels.com error rows "hotels.com"; everything else "unknown".
    const platform = error instanceof HotelsComDelistedError ? 'hotels.com' : 'unknown';
    return { id, platform };
}

await Actor.init();

const input = (await Actor.getInput<ActorInput>()) ?? {};

let urls: string[] = [];
if (Array.isArray(input.urls)) urls = input.urls;
else if (typeof input.urls === 'string') urls = [input.urls];
if (urls.length === 0 && input.url) urls = [input.url];

if (urls.length === 0) {
    log.warning('No URLs provided in input');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(
    input.proxyConfiguration ?? { groups: ['RESIDENTIAL'] },
);

const maxConcurrency = input.maxConcurrency ?? 10;
const maxRequestRetries = input.maxRequestRetries ?? input.maxRetries ?? 3;

const crawler = new BasicCrawler({
    maxConcurrency,
    maxRequestRetries,
    useSessionPool: true,
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
            log.info(`Success: ${result.name || `Property ${result.id}`}`);
        } catch (err) {
            // A soft-block (empty body) → retire the session so the retry rotates IP.
            if (err instanceof BlockedResponseError) session?.retire();
            throw err; // let Crawlee retry / route to failedRequestHandler
        }
    },

    async failedRequestHandler({ request }: BasicCrawlingContext, error: Error) {
        // Single source of every error row → preserves the one-row-per-URL invariant.
        const { id, platform } = errorRowMeta(request.url, error);
        const message = error?.message ?? String(error);
        await Actor.pushData(formatError(request.url, id, message, platform));
        log.error(`Failed: ${request.url} — ${message}`);
    },
});

log.info(`Processing ${urls.length} URLs (maxConcurrency=${maxConcurrency}, maxRequestRetries=${maxRequestRetries})`);
// RequestQueue dedups by URL and persists handled requests across abort/migration,
// so a resurrected run skips already-scraped Properties for free (ADR-0003).
await crawler.addRequests(urls.map((url) => ({ url })));
await crawler.run();

await Actor.exit();
