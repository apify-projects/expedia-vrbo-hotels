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

import { describe, expect,it } from 'vitest';

import type { HttpClient, HttpRequestInit, HttpResponse } from '../src/http/http-client.js';
import { scrapeProperty } from '../src/pipeline.js';

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

function mkResp(status: number, url: string, text: string): HttpResponse {
    return { status, url, text: async () => text, header: () => null };
}

/** Replays a fixture: GraphQL POSTs by operationName, prefetch GETs by URL. */
class FakeHttpClient implements HttpClient {
    constructor(private readonly fx: Fixture) {}

    async fetch(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
        const method = (init.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.endsWith('/graphql')) {
            const body = JSON.parse(init.body ?? '{}');
            const op = body.operationName as string;
            const resp = this.fx.graphql[op];
            if (resp === undefined) throw new Error(`fixture ${this.fx.name}: no GraphQL response for ${op}`);
            return mkResp(200, url, JSON.stringify(resp));
        }
        const html = this.fx.prefetch?.[url];
        if (html !== undefined) return mkResp(200, url, html);
        throw new Error(`fixture ${this.fx.name}: unexpected ${method} ${url}`);
    }
}

const fixtures: Fixture[] = readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(GOLDEN, f), 'utf8')) as Fixture);

const stripTs = (row: Record<string, any>) => {
    const { scrapedAt, ...rest } = row;
    return rest;
};

describe('parity gate — TS pipeline output vs Python golden rows', () => {
    it('captured at least one fixture per platform', () => {
        const platforms = new Set(fixtures.map((f) => f.platform));
        expect(platforms).toEqual(new Set(['expedia', 'hotels.com', 'vrbo']));
    });

    for (const fx of fixtures) {
        it(`${fx.name} (${fx.platform}) → row matches Python`, async () => {
            const deps = { makeClient: () => new FakeHttpClient(fx) };
            const row = await scrapeProperty(fx.url, deps);

            // scrapedAt is non-deterministic — assert shape, then ignore for the diff.
            expect(typeof row.scrapedAt).toBe('string');
            expect(stripTs(row)).toEqual(stripTs(fx.expectedRow));
        });
    }
});
