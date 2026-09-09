import { describe, expect, it } from 'vitest';

import { passThroughPipeline } from '../../packages/protocol/src/pipeline.js';
import type { RegisteredTool } from '../../packages/protocol/src/types.js';

const tool = (name: string): RegisteredTool => ({
    serverId: 'srv-1',
    serverAlias: 'docs',
    upstreamName: name,
    qualifiedName: `docs__${name}`,
    definition: { name }
});

const callContext = {
    correlationId: 'corr-1',
    serverId: 'srv-1',
    serverAlias: 'docs',
    upstreamName: 'search',
    qualifiedName: 'docs__search',
    args: { q: 'x' },
    receivedAt: new Date(0)
};

describe('passThroughPipeline', () => {
    // Phase 1 provides no enforcement. This is asserted rather than assumed so
    // that nobody can mistake a transparent proxy for a security control, and
    // so that the day a real pipeline lands, this test is what changes.
    it('declares itself non-enforcing', () => {
        expect(passThroughPipeline.enforcing).toBe(false);
        expect(passThroughPipeline.name).toBe('pass-through');
    });

    it('allows every tool call', async () => {
        await expect(passThroughPipeline.evaluateToolCall(callContext)).resolves.toEqual({ effect: 'ALLOW' });
    });

    it('returns the tool list unchanged', async () => {
        const tools = [tool('search'), tool('get_time')];
        await expect(passThroughPipeline.filterToolList({ correlationId: 'c', receivedAt: new Date(0) }, tools)).resolves.toEqual(tools);
    });

    it('is deterministic across repeated evaluation', async () => {
        const results = await Promise.all(Array.from({ length: 50 }, () => passThroughPipeline.evaluateToolCall(callContext)));
        expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    });
});
