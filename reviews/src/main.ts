import { CheerioCrawler, log } from '@crawlee/cheerio';
import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { Actor } from 'apify';

import { buildStartRequests } from './request-builders.js';
import { router } from './router.js';
import type { CrawlerState } from './types/common.js';
import type { Input } from './types/input.js';
import { chargeRunStart } from './utils/charging.js';

await Actor.init();

await chargeRunStart();

const input = await Actor.getInputOrThrow<Input>();

if (input.debugLog) {
    log.setLevel(log.LEVELS.DEBUG);
}

const startRequests = buildStartRequests(input);

if (startRequests.length === 0) {
    await Actor.fail('No usable hotel URLs in the input - add an Expedia, Hotels.com or Vrbo property URL');
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    checkAccess: false,
});

const crawler = new CheerioCrawler({
    proxyConfiguration,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    maxConcurrency: 25,
    maxRequestRetries: 20,
    requestHandler: router,
    sessionPoolOptions: {
        sessionOptions: {
            maxErrorScore: 1,
        },
    },
});

await crawler.useState<CrawlerState>({ reviewCounts: {} });

await crawler.run(startRequests);

await Actor.exit();
