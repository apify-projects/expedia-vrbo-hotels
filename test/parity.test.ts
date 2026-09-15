/**
 * Seam + parity gate.
 *
 * Drives the REAL per-URL pipeline (`scrapeProperty`) through a fake HttpClient
 * (the "faked impit boundary") that replays golden fixtures captured from the
 * live Python actor at cutover (provenance: test/fixtures/README.md). Asserts
 * the single Terminal row the TS pipeline produces equals the Python row.
 *
 * Normalization (per the PRD): `scrapedAt` is a non-deterministic timestamp and
 * is ignored; reading the fixture JSON in JS collapses Python's float text
 * (`9.0`) to the same JS number (`9`), so value-level equality holds.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scrapeProperty } from '../src/routes.js';
import type { Platform } from '../src/url-parser.js';
import { fakeSendRequest } from './fake-send-request.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'golden');

interface Fixture {
    name: string;
    url: string;
    platform: string;
    expectedRow: Record<string, any>;
    graphql: Record<string, unknown>;
    prefetch: Record<string, string>;
}

/** Replays a fixture's five GraphQL responses, keyed by operationName. */
const replay = (fx: Fixture) =>
    fakeSendRequest((url, options) => {
        if (options.method !== 'POST' || !url.endsWith('/graphql')) {
            throw new Error(`fixture ${fx.name}: unexpected ${options.method} ${url}`);
        }
        const { operationName } = JSON.parse(String(options.body ?? '{}'));
        const response = fx.graphql[operationName];
        if (response === undefined) throw new Error(`fixture ${fx.name}: no GraphQL response for ${operationName}`);
        return { body: JSON.stringify(response) };
    }).send;

const fixtures: Fixture[] = readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(GOLDEN, f), 'utf8')) as Fixture);

const stripTs = (row: Record<string, any>) => {
    const { scrapedAt, ...rest } = row;
    return rest;
};

describe('output gate — formatter output vs golden rows', () => {
    it('captured at least one fixture per platform', () => {
        const platforms = new Set(fixtures.map((f) => f.platform));
        expect(platforms).toEqual(new Set(['expedia', 'hotels.com', 'vrbo']));
    });

    for (const fx of fixtures) {
        it(`${fx.name} (${fx.platform}) → row matches the golden output`, async () => {
            const row = await scrapeProperty({
                url: fx.url,
                platform: fx.platform as Platform,
                propertyId: fx.expectedRow.id,
                sendRequest: replay(fx),
            });

            // scrapedAt is non-deterministic — assert shape, then ignore for the diff.
            expect(typeof row.scrapedAt).toBe('string');
            expect(stripTs(row)).toEqual(stripTs(fx.expectedRow));
        });
    }
});
