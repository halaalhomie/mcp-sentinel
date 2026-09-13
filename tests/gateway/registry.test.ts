/**
 * Registry validation: what happens when an upstream sends tool metadata that
 * does not conform to the specification.
 *
 * ## Why this suite uses a synthetic upstream
 *
 * Every other gateway suite drives a real MCP server, on the principle that a
 * mock only tests our assumptions about the protocol. This one cannot.
 *
 * Verified against SDK 2.0.0 on 2026-09-14: the SDK validates a handler's
 * result before putting it on the wire and rejects a non-conforming
 * `tools/list` with `INVALID_RESULT`. A server built on the official SDK is
 * therefore incapable of sending Sentinel the malformed metadata these branches
 * exist to handle.
 *
 * That is a genuine layer of protection — and precisely why it cannot be relied
 * on. A malicious server would not use the SDK; it would emit raw JSON-RPC. So
 * the registry validates independently, and the only way to exercise that code
 * is to feed it the bytes a hostile server would send.
 *
 * A raw non-SDK adversarial server arrives in Phase 8. Until then these tests
 * inject the responses directly.
 */

import { describe, expect, it } from 'vitest';

import type { UpstreamServerConfig } from '@mcp-sentinel/protocol';
import { ToolRegistry } from '../../apps/gateway/src/registry.js';
import type { UpstreamConnection, UpstreamPool } from '../../apps/gateway/src/upstream.js';
import { silentLogger } from '../../apps/gateway/src/logging.js';

const config = (alias: string): UpstreamServerConfig => ({
    id: `srv-${alias}`,
    alias,
    transport: { kind: 'stdio', command: 'node', args: [] },
    trustTier: 'UNTRUSTED',
    environment: 'dev'
});

/** An upstream that returns exactly the tool payload it is given. */
function fakeUpstream(alias: string, tools: unknown[]): UpstreamConnection {
    return {
        config: config(alias),
        alias,
        listTools: () => Promise.resolve({ tools } as never),
        callTool: () => Promise.reject(new Error('not used')),
        connect: () => Promise.resolve(),
        close: () => Promise.resolve()
    } as unknown as UpstreamConnection;
}

/** An upstream whose discovery always fails. */
function failingUpstream(alias: string): UpstreamConnection {
    return {
        config: config(alias),
        alias,
        listTools: () => Promise.reject(new Error('upstream is down')),
        callTool: () => Promise.reject(new Error('not used')),
        connect: () => Promise.resolve(),
        close: () => Promise.resolve()
    } as unknown as UpstreamConnection;
}

function poolOf(...connections: UpstreamConnection[]): UpstreamPool {
    return {
        all: () => connections,
        get: (id: string) => connections.find((c) => c.config.id === id),
        connectAll: () => Promise.resolve([]),
        closeAll: () => Promise.resolve()
    } as unknown as UpstreamPool;
}

const valid = { name: 'good_tool', description: 'fine', inputSchema: { type: 'object' } };

async function discover(...tools: unknown[]) {
    const registry = new ToolRegistry(silentLogger);
    const stats = await registry.refresh(poolOf(fakeUpstream('demo', tools)), 1_000);
    return { registry, stats };
}

describe('security invariant: malformed upstream tools are excluded, not repaired', () => {
    it.each([
        ['a name outside the MCP charset', { name: 'has spaces', inputSchema: { type: 'object' } }],
        ['a name with a semicolon', { name: 'drop;table', inputSchema: { type: 'object' } }],
        ['a path-traversal-looking name', { name: '../escape', inputSchema: { type: 'object' } }],
        ['a non-string name', { name: 42, inputSchema: { type: 'object' } }],
        ['a missing name', { inputSchema: { type: 'object' } }],
        ['a missing inputSchema', { name: 'no_schema' }],
        ['a null inputSchema', { name: 'null_schema', inputSchema: null }],
        ['an array inputSchema', { name: 'array_schema', inputSchema: [] }],
        ['a string inputSchema', { name: 'string_schema', inputSchema: 'object' }],
        ['an over-long name', { name: 'a'.repeat(200), inputSchema: { type: 'object' } }]
    ])('excludes a tool with %s', async (_label, bad) => {
        const { registry, stats } = await discover(valid, bad);

        expect(stats.excluded).toBe(1);
        expect(stats.discovered).toBe(1);
        // The one valid tool still gets through: a malformed sibling must not
        // take the catalog with it.
        expect(registry.list().map((t) => t.qualifiedName)).toEqual(['demo__good_tool']);
    });

    it('excludes several malformed tools while keeping every valid one', async () => {
        const { registry, stats } = await discover(
            valid,
            { name: 'also good', inputSchema: { type: 'object' } },
            { name: 'second_good', inputSchema: { type: 'object' } },
            { name: 'no_schema' },
            { name: 'null_schema', inputSchema: null }
        );

        expect(stats.excluded).toBe(3);
        expect(registry.list().map((t) => t.qualifiedName)).toEqual(['demo__good_tool', 'demo__second_good']);
    });

    it('never admits a malformed tool under any name', async () => {
        const { registry } = await discover({ name: 'has spaces', inputSchema: { type: 'object' } });

        // Neither the raw name nor any namespaced variant becomes routable.
        expect(registry.resolve('has spaces')).toBeUndefined();
        expect(registry.resolve('demo__has spaces')).toBeUndefined();
        expect(registry.size).toBe(0);
    });
});

describe('discovery failure isolation', () => {
    it('serves the tools of healthy upstreams when one fails discovery', async () => {
        const registry = new ToolRegistry(silentLogger);
        const stats = await registry.refresh(poolOf(failingUpstream('dead'), fakeUpstream('live', [valid])), 1_000);

        expect(stats.serversFailed).toBe(1);
        expect(stats.serversOk).toBe(1);
        // ARCHITECTURE.md NFR-R2: one bad server must not blind the agent to
        // every other server's tools.
        expect(registry.list().map((t) => t.qualifiedName)).toEqual(['live__good_tool']);
    });

    it('produces an empty catalog rather than throwing when every upstream fails', async () => {
        const registry = new ToolRegistry(silentLogger);
        const stats = await registry.refresh(poolOf(failingUpstream('a'), failingUpstream('b')), 1_000);

        expect(stats.serversFailed).toBe(2);
        expect(registry.size).toBe(0);
    });
});

describe('refresh replaces the routing table atomically', () => {
    it('drops tools that an upstream no longer exposes', async () => {
        const registry = new ToolRegistry(silentLogger);
        const removable = { name: 'temporary', inputSchema: { type: 'object' } };

        await registry.refresh(poolOf(fakeUpstream('demo', [valid, removable])), 1_000);
        expect(registry.size).toBe(2);

        await registry.refresh(poolOf(fakeUpstream('demo', [valid])), 1_000);
        expect(registry.size).toBe(1);
        // A tool that disappeared upstream must stop being routable, or the
        // gateway would keep advertising something it cannot serve.
        expect(registry.resolve('demo__temporary')).toBeUndefined();
    });

    it('keeps the previous table intact until a refresh completes', async () => {
        const registry = new ToolRegistry(silentLogger);
        await registry.refresh(poolOf(fakeUpstream('demo', [valid])), 1_000);

        // A refresh where every upstream fails empties the catalog rather than
        // silently serving stale routes. Phase 2 revisits this with manifest
        // history; today the behaviour is simply recorded.
        await registry.refresh(poolOf(failingUpstream('demo')), 1_000);
        expect(registry.size).toBe(0);
    });
});
