/**
 * A configurable stand-in for Crawlee's `sendRequest`. A `Route` maps each
 * request to a canned response; `calls` records what was asked for, so a test
 * can assert a "no network" path.
 */
import type { SendRequest } from '../src/property-client.js';

export interface RouteResult {
    statusCode?: number;
    url?: string;
    body?: string;
    headers?: Record<string, string>;
}

export type Route = (url: string, options: { method?: string; body?: unknown }) => RouteResult | null | undefined;

export interface FakeSendRequest {
    send: SendRequest;
    calls: { url: string; method: string }[];
}

export function fakeSendRequest(route: Route): FakeSendRequest {
    const calls: { url: string; method: string }[] = [];

    const send = (async (options: Record<string, any> = {}) => {
        const url = String(options.url ?? '');
        const method = String(options.method ?? 'GET');
        calls.push({ url, method });

        const result = route(url, options) ?? {};
        // Handlers read body/statusCode/url/headers; the rest of Crawlee's
        // response shape is irrelevant here.
        return {
            body: result.body ?? '',
            statusCode: result.statusCode ?? 200,
            url: result.url ?? url,
            headers: result.headers ?? {},
            trailers: {},
            redirectUrls: [],
            complete: true,
            request: options,
        } as unknown as Awaited<ReturnType<SendRequest>>;
    }) as SendRequest;

    return { send, calls };
}
