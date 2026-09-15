import { describe, expect, it } from 'vitest';

import {
    buildAuthorizationHeader,
    buildSigningData,
    createHmacSignature,
    generateSalt,
    getRfc1123Date,
    getSignedHeaders,
    HMAC_SECRET_KEY,
    HMAC_USERNAME,
} from '../src/auth.js';

// Oracle: values produced by the Python src/auth.py for fixed inputs.
// The HMAC port must match these BYTE-FOR-BYTE (PRD testing decision #24).
const ORACLE = {
    username: 'fe627e29-3afb-4384-9fc0-a1d2a4dcd30c',
    secret: 'S1q3f5rhAe3SCE4N',
    cases: [
        {
            method: 'POST',
            path: '/graphql',
            query: null,
            date: 'Fri, 29 Nov 2024 12:34:56 GMT',
            salt: 'abc123DEF456ghij',
            signingData: 'POST /graphql HTTP/1.1\nx-date: Fri, 29 Nov 2024 12:34:56 GMT\nsalt: abc123DEF456ghij',
            signature: 'ZqdQFgwfWLl0sVcoorkssmRUiA1PxJ/iklNYCKX6T4M=',
            authorization:
                'hmac username="fe627e29-3afb-4384-9fc0-a1d2a4dcd30c",algorithm="hmac-sha256",headers="request-line x-date salt",signature="ZqdQFgwfWLl0sVcoorkssmRUiA1PxJ/iklNYCKX6T4M="',
        },
        {
            method: 'POST',
            path: '/graphql',
            query: 'a=1&b=2',
            date: 'Mon, 20 Jan 2025 00:00:00 GMT',
            salt: 'ZZZZ0000zzzz9999',
            signingData:
                'POST /graphql?a=1&b=2 HTTP/1.1\nx-date: Mon, 20 Jan 2025 00:00:00 GMT\nsalt: ZZZZ0000zzzz9999',
            signature: 'QA+5RrwYASphyxJG4ixUAk/NcIKoJB3Urenw2OOC4dc=',
            authorization:
                'hmac username="fe627e29-3afb-4384-9fc0-a1d2a4dcd30c",algorithm="hmac-sha256",headers="request-line x-date salt",signature="QA+5RrwYASphyxJG4ixUAk/NcIKoJB3Urenw2OOC4dc="',
        },
        {
            method: 'GET',
            path: '/foo/bar',
            query: null,
            date: 'Tue, 01 Apr 2025 23:59:59 GMT',
            salt: 'SaltSaltSaltSalt',
            signingData: 'GET /foo/bar HTTP/1.1\nx-date: Tue, 01 Apr 2025 23:59:59 GMT\nsalt: SaltSaltSaltSalt',
            signature: 'DkI1vFhckN6JQxV5XFSdTc6DXZfNNaS1ptq8u2/ubDY=',
            authorization:
                'hmac username="fe627e29-3afb-4384-9fc0-a1d2a4dcd30c",algorithm="hmac-sha256",headers="request-line x-date salt",signature="DkI1vFhckN6JQxV5XFSdTc6DXZfNNaS1ptq8u2/ubDY="',
        },
    ],
};

describe('auth HMAC - byte-equality vs Python', () => {
    it('uses the same credentials', () => {
        expect(HMAC_USERNAME).toBe(ORACLE.username);
        expect(HMAC_SECRET_KEY).toBe(ORACLE.secret);
    });

    for (const c of ORACLE.cases) {
        it(`signs ${c.method} ${c.path}${c.query ? `?${c.query}` : ''}`, () => {
            expect(buildSigningData(c.method, c.path, c.query, c.date, c.salt)).toBe(c.signingData);
            expect(createHmacSignature(ORACLE.secret, c.signingData)).toBe(c.signature);
            expect(buildAuthorizationHeader(c.method, c.path, c.query, c.date, c.salt)).toBe(c.authorization);
        });
    }
});

describe('auth helpers', () => {
    it('generateSalt returns 16 alphanumeric chars by default', () => {
        const s = generateSalt();
        expect(s).toHaveLength(16);
        expect(s).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('generateSalt respects length', () => {
        expect(generateSalt(8)).toHaveLength(8);
    });

    it('getRfc1123Date matches RFC 1123 GMT shape', () => {
        expect(getRfc1123Date()).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    });

    it('getSignedHeaders returns authorization, x-date, salt', () => {
        const h = getSignedHeaders('POST', '/graphql');
        expect(h.authorization).toMatch(/^hmac username="/);
        expect(h['x-date']).toMatch(/GMT$/);
        expect(h.salt).toHaveLength(16);
    });
});
