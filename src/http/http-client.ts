/**
 * The HTTP boundary — the single seam the whole pipeline goes through.
 *
 * The real implementation (impit-client.ts) impersonates okhttp4; tests swap in
 * a fake that returns captured response bodies (PRD's "faked impit boundary").
 * Headers are read via a case-insensitive `header()` so callers never repeat the
 * old tls_client "Location vs location" hack.
 */
export interface HttpResponse {
    status: number;
    url: string;
    text(): Promise<string>;
    /** Case-insensitive single-header lookup; null if absent. */
    header(name: string): string | null;
}

export interface HttpRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'manual' | 'error';
    timeoutMs?: number;
}

export interface HttpClient {
    fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
}
