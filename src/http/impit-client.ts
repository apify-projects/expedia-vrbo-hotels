/**
 * Real HTTP client: impit impersonating okhttp4 (ADR-0001, validated by the
 * gate-zero spike in issue #2). One instance == one sticky (possibly proxied)
 * user agent; the pipeline creates one per Property URL so the 5 GraphQL calls
 * share a single residential IP.
 */
import { type Browser, type HttpMethod,Impit } from 'impit';

import type { HttpClient, HttpRequestInit, HttpResponse } from './http-client.js';

export interface ImpitClientOptions {
    /** Residential proxy URL (one sticky session/IP per Property URL). */
    proxyUrl?: string;
    /** TLS fingerprint target; okhttp4 is the validated default. */
    browser?: Browser;
    timeoutMs?: number;
    followRedirects?: boolean;
}

export class ImpitHttpClient implements HttpClient {
    private readonly impit: Impit;

    private readonly defaultTimeout: number;

    constructor(opts: ImpitClientOptions = {}) {
        this.defaultTimeout = opts.timeoutMs ?? 30_000;
        this.impit = new Impit({
            browser: opts.browser ?? 'okhttp4',
            proxyUrl: opts.proxyUrl,
            ignoreTlsErrors: true,
            followRedirects: opts.followRedirects ?? true,
            timeout: this.defaultTimeout,
        });
    }

    async fetch(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
        const resp = await this.impit.fetch(url, {
            method: (init.method ?? 'GET') as HttpMethod,
            headers: init.headers,
            body: init.body,
            redirect: init.redirect,
            timeout: init.timeoutMs ?? this.defaultTimeout,
        });
        return {
            status: resp.status,
            url: resp.url,
            text: () => resp.text(),
            header: (name: string) => resp.headers.get(name),
        };
    }
}
