import { describe, expect, it } from 'vitest';

import {
    SentinelError,
    SentinelErrorCode,
    isSpecReservedErrorCode,
    toClientFacingError
} from '../../packages/protocol/src/errors.js';

describe('security invariant: error code allocation', () => {
    // The MCP specification reserves -32020..-32099 for itself and states that
    // implementations MUST NOT emit undefined codes from that sub-range.
    it('allocates every Sentinel code outside the spec-reserved range', () => {
        for (const [name, code] of Object.entries(SentinelErrorCode)) {
            expect(isSpecReservedErrorCode(code), `${name} (${code}) is inside the spec-reserved range`).toBe(false);
        }
    });

    it('allocates every Sentinel code inside the implementation-defined range', () => {
        for (const [name, code] of Object.entries(SentinelErrorCode)) {
            expect(code, `${name} is below the implementation-defined range`).toBeLessThanOrEqual(-32000);
            expect(code, `${name} is above the implementation-defined range`).toBeGreaterThanOrEqual(-32019);
        }
    });

    it('assigns a distinct code to every reason', () => {
        const codes = Object.values(SentinelErrorCode);
        expect(new Set(codes).size).toBe(codes.length);
    });
});

describe('toClientFacingError', () => {
    it('passes through a SentinelError message and details', () => {
        const error = new SentinelError(SentinelErrorCode.UPSTREAM_TIMEOUT, 'The upstream server did not respond in time.', {
            serverAlias: 'docs'
        });

        expect(toClientFacingError(error, 'corr-1')).toEqual({
            code: SentinelErrorCode.UPSTREAM_TIMEOUT,
            message: 'The upstream server did not respond in time.',
            data: { correlationId: 'corr-1', serverAlias: 'docs' }
        });
    });

    it('always carries the correlation id so a caller can be helped from the logs', () => {
        expect(toClientFacingError(new Error('boom'), 'corr-2').data.correlationId).toBe('corr-2');
    });

    describe('security invariant: internal detail never reaches the caller', () => {
        const leaky = [
            new Error('connect ECONNREFUSED 10.0.3.14:8931'),
            new Error('password authentication failed for user "sentinel"'),
            Object.assign(new Error('upstream https://internal.corp.example/mcp failed'), {
                stack: 'Error: at /srv/sentinel/src/upstream/pool.ts:88'
            }),
            'a bare thrown string with /etc/passwd in it',
            { message: 'Bearer eyJhbGciOiJIUzI1NiIs' }
        ];

        it.each(leaky.map((e, i) => [i, e] as const))('sanitizes thrown value %i', (_i, thrown) => {
            const result = toClientFacingError(thrown, 'corr-3');
            const serialized = JSON.stringify(result);

            expect(result.message).toBe('Internal gateway error.');
            for (const secret of ['10.0.3.14', 'password', 'internal.corp.example', 'pool.ts', '/etc/passwd', 'eyJhbGciOiJIUzI1NiIs']) {
                expect(serialized).not.toContain(secret);
            }
        });
    });
});
