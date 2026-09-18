import { load } from 'cheerio';
import type { CheerioAPI } from 'crawlee';

/**
 * Builds the parsed page a handler would get from the crawler.
 *
 * cheerio ships separate CJS and ESM type declarations. Crawlee's `$` is the CJS
 * one, an ESM `load()` returns the other, and the two are identical at runtime
 * but not assignable. The cast covers that and nothing else.
 */
export function loadPage(html: string): CheerioAPI {
    return load(html) as unknown as CheerioAPI;
}
