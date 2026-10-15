import { describe, expect, it } from 'vitest';

import { validatePropertyResponse } from '../src/response-validation.js';

const ok = (id: string, name: string) => ({ data: { propertyInfo: { summary: { id, name } } } });

describe('validatePropertyResponse', () => {
    it('accepts a matching id with a real name', () => {
        expect(validatePropertyResponse(ok('525006', 'Hotel PULSE8'), '525006')).toEqual({
            valid: true,
            reason: 'Valid',
        });
    });

    it('accepts when ids match ignoring suffix', () => {
        expect(validatePropertyResponse(ok('117898910', 'X'), '117898910vb').valid).toBe(true);
    });

    it('rejects a blank name (dead listing / unresolved legacy id)', () => {
        const r = validatePropertyResponse(ok('525006', '   '), '525006');
        expect(r.valid).toBe(false);
        expect(r.reason).toContain('Empty response');
    });

    it('rejects a missing summary entirely', () => {
        expect(validatePropertyResponse({ data: { propertyInfo: {} } }, '525006').valid).toBe(false);
    });

    it('rejects a wrong property', () => {
        const r = validatePropertyResponse(ok('999999', 'Other Hotel'), '525006');
        expect(r.valid).toBe(false);
        expect(r.reason).toContain('Wrong property');
    });
});
