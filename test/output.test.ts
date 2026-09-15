/**
 * Output gate.
 *
 * Drives the real per-URL pipeline (`scrapeProperty`) through a fake HttpClient
 * that replays the captured GraphQL responses for one Property per Platform, and
 * checks the item it produces two ways: invariants that must hold for any
 * Property, then field-for-field equality with the reviewed item in the fixture,
 * which catches unintended changes.
 *
 * `scrapedAt` is a timestamp, so it is asserted as a shape and ignored in the
 * diff.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { findExpediaId } from '../src/resolvers.js';
import { scrapeProperty } from '../src/routes.js';
import type { Platform } from '../src/url-parser.js';
import { fakeSendRequest } from './fake-send-request.js';
import { loadPage } from './load-page.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'golden');

// TemplatePageLayout is Vrbo-only; for the others it is ~430 KB that changes
// nothing in the item.
const SHARED_OPERATIONS = ['PropertySummary', 'PropertyContent', 'ProductGallery', 'PropertyOffers'];

/** Fields the API leaves empty on every Platform, so the output must not carry them. */
const DROPPED_FIELDS = /^(ratingText|tagline|host|price|pricing)$/;

interface Fixture {
    name: string;
    url: string;
    platform: Platform;
    expectedItem: Record<string, any>;
    graphql: Record<string, unknown>;
    prefetch: Record<string, string>;
}

const fixtures: Fixture[] = readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(GOLDEN, f), 'utf8')) as Fixture);

const fixtureFor = (platform: Platform) => fixtures.find((f) => f.platform === platform)!;

/** Replays a fixture's GraphQL responses, recording which operations were asked for. */
function replay(fx: Fixture) {
    const operations: string[] = [];
    const { send } = fakeSendRequest((url, options) => {
        if (options.method !== 'POST' || !url.endsWith('/graphql')) {
            throw new Error(`fixture ${fx.name}: unexpected ${options.method} ${url}`);
        }
        const { operationName } = JSON.parse(String(options.body ?? '{}'));
        operations.push(operationName);
        const response = fx.graphql[operationName];
        if (response === undefined) throw new Error(`fixture ${fx.name}: no GraphQL response for ${operationName}`);
        return { body: JSON.stringify(response) };
    });
    return { send, operations };
}

/** Every node in a item, so an invariant can be asserted across the whole tree. */
function* walk(value: unknown, path = 'item'): Generator<{ path: string; key: string; value: unknown }> {
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) yield* walk(item, `${path}[${index}]`);
    } else if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            yield { path: `${path}.${key}`, key, value: item };
            yield* walk(item, `${path}.${key}`);
        }
    }
}

const stripTs = (item: Record<string, any>) => {
    const { scrapedAt, ...rest } = item;
    return rest;
};

describe('output gate', () => {
    it('has a fixture for every platform', () => {
        expect(new Set(fixtures.map((f) => f.platform))).toEqual(new Set(['expedia', 'hotels.com', 'vrbo']));
    });
});

for (const fx of fixtures) {
    describe(`${fx.name} (${fx.platform})`, () => {
        let item: Record<string, any>;
        let operations: string[];

        beforeAll(async () => {
            const session = replay(fx);
            item = await scrapeProperty({
                url: fx.url,
                platform: fx.platform,
                propertyId: fx.expectedItem.id,
                sendRequest: session.send,
            });
            operations = session.operations;
        });

        it('asks for the queries this platform needs, and no others', () => {
            const expected = fx.platform === 'vrbo' ? [...SHARED_OPERATIONS, 'TemplatePageLayout'] : SHARED_OPERATIONS;
            expect(operations.sort()).toEqual([...expected].sort());
        });

        it('identifies the property it was asked about', () => {
            expect(item.platform).toBe(fx.platform);
            expect(item.url).toBe(fx.url);
            expect(item.id).toMatch(/^\d+$/);
            expect(item.name.trim()).not.toBe('');
            expect(Number.isNaN(Date.parse(item.scrapedAt))).toBe(false);
        });

        it('keeps ratings and counts in range', () => {
            // Expedia's raw score is on a doubled scale; a regression there lands
            // outside 0-10.
            if (item.rating !== null) {
                expect(item.rating).toBeGreaterThan(0);
                expect(item.rating).toBeLessThanOrEqual(10);
            }
            for (const field of ['reviewCount', 'guestCount', 'bedroomCount', 'bathroomCount']) {
                if (item[field] !== null) expect(item[field], field).toBeGreaterThanOrEqual(0);
            }
            if (item.latitude !== null) expect(Math.abs(item.latitude)).toBeLessThanOrEqual(90);
            if (item.longitude !== null) expect(Math.abs(item.longitude)).toBeLessThanOrEqual(180);
        });

        it('carries images and units', () => {
            expect(item.images.length).toBeGreaterThan(0);
            expect(item.units.length).toBeGreaterThan(0);
            if (item.thumbnail !== null) expect(item.thumbnail).toMatch(/^https:\/\//);
            for (const { path, key, value } of walk(item)) {
                if (key === 'url') expect(value, path).toMatch(/^https:\/\//);
            }
            for (const bed of item.units.flatMap((unit: any) => unit.bedTypes ?? [])) {
                expect(bed.type.trim()).not.toBe('');
                expect(bed.count).toBeGreaterThan(0);
            }
        });

        it('uses null, never a blank string, for what it does not know', () => {
            const blanks = [...walk(item)]
                .filter(({ value }) => typeof value === 'string' && value.trim() === '')
                .map(({ path }) => path);
            expect(blanks).toEqual([]);
        });

        it('does not carry the fields the api never fills', () => {
            const present = [...walk(item)].filter(({ key }) => DROPPED_FIELDS.test(key)).map(({ path }) => path);
            expect(present).toEqual([]);
        });

        it('matches the reviewed item field for field', () => {
            expect(typeof item.scrapedAt).toBe('string');
            expect(stripTs(item)).toEqual(stripTs(fx.expectedItem));
        });
    });
}

describe('id resolution against a real captured page', () => {
    it('reads the expedia id out of the hotels.com page', () => {
        const fx = fixtureFor('hotels.com');
        const [html] = Object.values(fx.prefetch);
        expect(findExpediaId(loadPage(html))).toBe(fx.expectedItem.id);
    });
});
