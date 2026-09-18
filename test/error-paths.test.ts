/**
 * Error paths: every one asserts a THROW, so the route pushes no success item and
 * the single error item comes from the failedRequestHandler.
 */
import { describe, expect, it } from 'vitest';

import { BlockedResponseError, PropertyNotFoundError } from '../src/errors.js';
import { formatError } from '../src/formatter.js';
import { makeExpediaProfile, PropertyClient } from '../src/property-client.js';
import { assertPageHasContent, scrapeProperty } from '../src/routes.js';
import { EXPEDIA_SITE_CONFIGS } from '../src/site-configs.js';
import { fakeSendRequest, type Route } from './fake-send-request.js';
import { loadPage } from './load-page.js';

const summaryRoute =
    (name: string | null): Route =>
    () => ({
        body: JSON.stringify({ data: { propertyInfo: { summary: { id: '1', name } } } }),
    });

const client = (route: Route) =>
    new PropertyClient({
        profile: makeExpediaProfile(EXPEDIA_SITE_CONFIGS['expedia.com']),
        site: EXPEDIA_SITE_CONFIGS['expedia.com'],
        sendRequest: fakeSendRequest(route).send,
    });

describe('a blank-name response is a dead id on every platform', () => {
    it.each(['vrbo', 'expedia', 'hotels.com'] as const)('%s -> PropertyNotFoundError', async (platform) => {
        await expect(
            scrapeProperty({
                url: 'https://www.example.com/x',
                platform,
                propertyId: '9999',
                sendRequest: fakeSendRequest(summaryRoute('')).send,
            }),
        ).rejects.toBeInstanceOf(PropertyNotFoundError);
    });
});

describe('dead property ids are not retried', () => {
    const gqlErrors = (...messages: string[]) => JSON.stringify({ errors: messages.map((message) => ({ message })) });

    it('"Failed to retrieve Property" -> PropertyNotFoundError', async () => {
        const route: Route = () => ({
            body: gqlErrors(
                'Exception while fetching data (/propertyInfo/summary) : Failed to retrieve Property. Property id=9999',
            ),
        });
        await expect(client(route).fetchPropertySummary('9999')).rejects.toBeInstanceOf(PropertyNotFoundError);
    });

    it('"Failed to retrieve Hotel Summary" -> PropertyNotFoundError', async () => {
        const route: Route = () => ({
            body: gqlErrors(
                'Exception while fetching data (/propertyInfo/propertyDetails) : Failed to retrieve Hotel Summary. Hotel = 9999',
            ),
        });
        await expect(client(route).fetchPropertySummary('9999')).rejects.toBeInstanceOf(PropertyNotFoundError);
    });

    it('an unrelated GraphQL error stays retryable', async () => {
        const route: Route = () => ({
            body: gqlErrors('Upstream exception with statusCode=3 occurred while calling gRPC API'),
        });
        const promise = client(route).fetchProductGallery('525006');
        await expect(promise).rejects.toThrow(/GraphQL errors/);
        await expect(promise).rejects.not.toBeInstanceOf(PropertyNotFoundError);
    });

    it('a wrong-property response stays retryable', async () => {
        const route: Route = () => ({
            body: JSON.stringify({ data: { propertyInfo: { summary: { id: '111', name: 'Someone Else' } } } }),
        });
        const promise = client(route).fetchPropertySummary('525006');
        await expect(promise).rejects.toThrow(/Wrong property/);
        await expect(promise).rejects.not.toBeInstanceOf(PropertyNotFoundError);
    });
});

describe('block detection -> BlockedResponseError, so the session rotates', () => {
    it.each([429, 403])('HTTP %i', async (statusCode) => {
        await expect(client(() => ({ statusCode, body: '' })).fetchPropertySummary('525006')).rejects.toBeInstanceOf(
            BlockedResponseError,
        );
    });

    it('empty GraphQL body', async () => {
        await expect(client(() => ({ body: '' })).fetchPropertySummary('525006')).rejects.toBeInstanceOf(
            BlockedResponseError,
        );
    });

    it('empty page from a navigated request', () => {
        const url = 'https://www.hotels.com/ho118568/';
        expect(() => assertPageHasContent(loadPage(''), url)).toThrow(BlockedResponseError);
        expect(() => assertPageHasContent(loadPage('   '), url)).toThrow(BlockedResponseError);
        // A bare skeleton is the other shape a soft-block arrives in.
        expect(() => assertPageHasContent(loadPage('<html><head></head><body></body></html>'), url)).toThrow(
            BlockedResponseError,
        );
        expect(() => assertPageHasContent(loadPage('<html>ok</html>'), url)).not.toThrow();
    });
});

describe('formatError -> one structured error item', () => {
    it('reports the platform as its machine value', () => {
        expect(formatError('https://www.vrbo.com/x', '123', 'boom', 'vrbo').platform).toBe('vrbo');
        expect(formatError('https://www.expedia.co.uk/x', '1', 'boom', 'expedia').platform).toBe('expedia');
        expect(formatError('https://www.hotels.com/x', '1', 'boom', 'hotels.com').platform).toBe('hotels.com');
    });

    it('uses null, not a placeholder, when the platform is undetectable', () => {
        expect(formatError('https://www.booking.com/x', 'unknown', 'boom', null).platform).toBeNull();
    });

    it('carries platform, url, id, error + a scrapedAt timestamp', () => {
        const item = formatError('https://www.vrbo.com/x', '123', 'boom', 'vrbo');
        expect(item).toMatchObject({ platform: 'vrbo', url: 'https://www.vrbo.com/x', id: '123', error: 'boom' });
        expect(typeof item.scrapedAt).toBe('string');
        expect(Object.keys(item).sort()).toEqual(['error', 'id', 'platform', 'scrapedAt', 'url']);
    });
});
