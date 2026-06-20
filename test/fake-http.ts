/**
 * Configurable fake HttpClient for deterministic tests (the faked impit
 * boundary). A `Route` maps each request to a canned response; `calls` records
 * what was fetched so a test can assert "no network" paths.
 */
import type { HttpClient, HttpRequestInit, HttpResponse } from '../src/http/http-client.js';

export interface RouteResult {
    status?: number;
    url?: string;
    text?: string;
    headers?: Record<string, string>;
}

export type Route = (url: string, init: HttpRequestInit) => RouteResult | null | undefined;

export class FakeHttp implements HttpClient {
    public readonly calls: { url: string; init: HttpRequestInit }[] = [];

    constructor(private readonly route: Route) {}

    async fetch(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
        this.calls.push({ url, init });
        const r = this.route(url, init) ?? {};
        const headers = Object.fromEntries(
            Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        );
        return {
            status: r.status ?? 200,
            url: r.url ?? url,
            text: async () => r.text ?? '',
            header: (name: string) => headers[name.toLowerCase()] ?? null,
        };
    }
}
