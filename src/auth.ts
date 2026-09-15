/**
 * HMAC signing for Expedia Group Mobile GraphQL API authentication.
 *
 * Works for Vrbo, Expedia and Hotels.com - all three share the same credentials.
 * The signature scheme is the reverse-engineered HMACInterceptor from the Expedia
 * Android apps.
 *
 * `test/auth.test.ts` pins the output against signatures captured from a known
 * working client, so a change here has to keep those passing.
 */
import { createHmac } from 'node:crypto';

// Credentials from the Expedia app (strings.xml), shared across all platforms.
// App-extracted constants, not user secrets (see PRD).
export const HMAC_USERNAME = 'fe627e29-3afb-4384-9fc0-a1d2a4dcd30c';
export const HMAC_SECRET_KEY = 'S1q3f5rhAe3SCE4N'; // Deobfuscated from XOR ^ 28 + reverse

const SALT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface SignedHeaders {
    authorization: string;
    'x-date': string;
    salt: string;
}

/** Generate a random alphanumeric salt (default 16 chars), matching Python's charset. */
export function generateSalt(length = 16): string {
    let out = '';
    for (let i = 0; i < length; i++) {
        out += SALT_CHARS[Math.floor(Math.random() * SALT_CHARS.length)];
    }
    return out;
}

/** Current date in RFC 1123 format (GMT), e.g. "Fri, 29 Nov 2024 12:34:56 GMT". */
export function getRfc1123Date(): string {
    // Node's toUTCString() yields exactly the RFC 1123 GMT form Python builds
    // with strftime("%a, %d %b %Y %H:%M:%S GMT").
    return new Date().toUTCString();
}

/**
 * Build the data string to be signed:
 *   {METHOD} {PATH}[?{QUERY}] HTTP/1.1
 *   x-date: {DATE}
 *   salt: {SALT}
 */
export function buildSigningData(
    method: string,
    path: string,
    query: string | null | undefined,
    date: string,
    salt: string,
): string {
    let requestLine = `${method} ${path}`;
    if (query) requestLine += `?${query}`;
    requestLine += ' HTTP/1.1';
    return `${requestLine}\nx-date: ${date}\nsalt: ${salt}`;
}

/** HMAC-SHA256 signature, base64-encoded. */
export function createHmacSignature(secretKey: string, data: string): string {
    return createHmac('sha256', secretKey).update(data, 'utf8').digest('base64');
}

/**
 * Full Authorization header value:
 *   hmac username="{username}",algorithm="hmac-sha256",headers="request-line x-date salt",signature="{sig}"
 */
export function buildAuthorizationHeader(
    method: string,
    path: string,
    query: string | null | undefined,
    date: string,
    salt: string,
    username: string = HMAC_USERNAME,
    secretKey: string = HMAC_SECRET_KEY,
): string {
    const data = buildSigningData(method, path, query, date, salt);
    const signature = createHmacSignature(secretKey, data);
    return (
        `hmac username="${username}",` +
        `algorithm="hmac-sha256",` +
        `headers="request-line x-date salt",` +
        `signature="${signature}"`
    );
}

/** All headers needed for a signed request: authorization, x-date, salt. */
export function getSignedHeaders(method: string, path: string, query?: string | null): SignedHeaders {
    const date = getRfc1123Date();
    const salt = generateSalt(16);
    return {
        authorization: buildAuthorizationHeader(method, path, query, date, salt),
        'x-date': date,
        salt,
    };
}
