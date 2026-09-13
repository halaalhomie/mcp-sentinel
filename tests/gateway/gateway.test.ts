/**
 * Gateway integration tests: downstream MCP client -> Sentinel -> real upstreams.
 *
 * The gateway is driven over `InMemoryTransport` rather than HTTP. That keeps
 * these tests focused on handler and routing behaviour; the HTTP listener and
 * its protocol-era negotiation arrive in a later checkpoint and are tested
 * there.
 *
 * Note on protocol era: over an in-memory transport the SDK negotiates the
 * 2025-era path, because `server/discover` is not served by the low-level
 * `Server`. These tests therefore verify request handling, not era behaviour.
 *
 * Two upstreams are registered from the same demo binary under different
 * aliases, which is what makes aggregation and namespacing observable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { passThroughPipeline, type SecurityPipeline, type UpstreamServerConfig } from '@mcp-sentinel/protocol';
import { createSentinelServer } from '../../apps/gateway/src/gateway.js';
import { ToolRegistry } from '../../apps/gateway/src/registry.js';
import { UpstreamPool } from '../../apps/gateway/src/upstream.js';
import { silentLogger } from '../../apps/gateway/src/logging.js';
import { DEMO_STDIO_ENTRY, DEMO_TOOL_NAMES } from '../helpers/demoServer.js';

const upstreamConfig = (id: string, alias: string): UpstreamServerConfig => ({
    id,
    alias,
    transport: { kind: 'stdio', command: process.execPath, args: [DEMO_STDIO_ENTRY] },
    trustTier: 'VERIFIED',
    environment: 'dev'
});

const configs = [upstreamConfig('srv-a', 'alpha'), upstreamConfig('srv-b', 'beta')];

let pool: UpstreamPool;
let registry: ToolRegistry;

/** Connect a downstream client to a gateway built with the given pipeline. */
async function connectClient(pipeline: SecurityPipeline = passThroughPipeline): Promise<Client> {
    const server = createSentinelServer({ registry, pipeline, logger: silentLogger });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    return client;
}

beforeAll(async () => {
    pool = new UpstreamPool(configs, silentLogger);
    const failed = await pool.connectAll();
    expect(failed).toEqual([]);

    registry = new ToolRegistry(silentLogger);
    await registry.refresh(pool, 20_000);
}, 90_000);

afterAll(async () => {
    await pool?.closeAll();
});

describe('tool discovery and aggregation', () => {
    it('registers every tool from every upstream', () => {
        // Two upstreams, each exposing the same six demo tools.
        expect(registry.size).toBe(DEMO_TOOL_NAMES.length * configs.length);
    });

    it('namespaces tools by the operator-assigned alias', () => {
        const names = registry.list().map((t) => t.qualifiedName);

        expect(names).toContain('alpha__echo');
        expect(names).toContain('beta__echo');
        // The upstream's own name is never exposed unqualified.
        expect(names).not.toContain('echo');
    });

    it('returns tools in a deterministic order', () => {
        // The spec says servers SHOULD return a stable order so clients can
        // cache and LLM prompt caches stay warm.
        const first = registry.list().map((t) => t.qualifiedName);
        const second = registry.list().map((t) => t.qualifiedName);

        expect(first).toEqual(second);
        expect(first).toEqual([...first].sort());
    });
});

describe('tools/list over MCP', () => {
    let client: Client;

    beforeAll(async () => {
        client = await connectClient();
    });

    afterAll(async () => {
        await client?.close();
    });

    it('serves the aggregated, namespaced catalog', async () => {
        const result = await client.listTools({}, { cache: 'bypass' });
        const names = result.tools.map((t) => t.name).sort();

        expect(names).toHaveLength(12);
        expect(names).toContain('alpha__add');
        expect(names).toContain('beta__slow');
    });

    it('rewrites the name and nothing else', async () => {
        const result = await client.listTools({}, { cache: 'bypass' });
        const echo = result.tools.find((t) => t.name === 'alpha__echo');

        expect(echo).toBeDefined();
        // Description and schema must arrive exactly as the upstream sent them.
        expect(echo?.description).toBe('Returns the message it was given.');
        expect(echo?.title).toBe('Echo');
        expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    });

    it('preserves an upstream outputSchema', async () => {
        const result = await client.listTools({}, { cache: 'bypass' });
        const add = result.tools.find((t) => t.name === 'alpha__add');

        expect(add?.outputSchema).toMatchObject({ type: 'object' });
    });
});

describe('security invariant: the catalog is whatever the pipeline permits', () => {
    it('omits tools the pipeline filters out', async () => {
        // A pipeline that hides every destructive-sounding tool. Phase 1 has no
        // real policy engine, so this stands in for one to prove the seam is
        // actually consulted rather than decorative.
        const restrictive: SecurityPipeline = {
            name: 'test-restrictive',
            enforcing: true,
            evaluateToolCall: passThroughPipeline.evaluateToolCall,
            filterToolList: (_ctx, tools) => Promise.resolve(tools.filter((t) => !t.upstreamName.startsWith('fail')))
        };

        const client = await connectClient(restrictive);
        try {
            const names = (await client.listTools({}, { cache: 'bypass' })).tools.map((t) => t.name);

            expect(names).not.toContain('alpha__fail_soft');
            expect(names).not.toContain('beta__fail_hard');
            expect(names).toContain('alpha__echo');
        } finally {
            await client.close();
        }
    });

    it('serves an empty catalog when the pipeline permits nothing', async () => {
        const denyAll: SecurityPipeline = {
            name: 'test-deny-all',
            enforcing: true,
            evaluateToolCall: passThroughPipeline.evaluateToolCall,
            filterToolList: () => Promise.resolve([])
        };

        const client = await connectClient(denyAll);
        try {
            // An empty tool set is valid per the specification, and is the
            // correct fail-closed answer — not an error.
            expect((await client.listTools({}, { cache: 'bypass' })).tools).toEqual([]);
        } finally {
            await client.close();
        }
    });
});

describe('unsupported methods', () => {
    let client: Client;

    beforeAll(async () => {
        client = await connectClient();
    });

    afterAll(async () => {
        await client?.close();
    });

    // Verified against SDK 2.0.0 on 2026-09-14: a conforming client does not
    // even send `resources/list` or `prompts/list` when the server has not
    // advertised those capabilities — it short-circuits and returns an empty
    // list. Sentinel declaring only `{ tools: {} }` is therefore a free layer
    // of defence in depth: well-behaved clients never ask.
    it.each([
        ['resources', () => client.listResources({}, { cache: 'bypass' }), 'resources'],
        ['prompts', () => client.listPrompts({}, { cache: 'bypass' }), 'prompts']
    ])('a conforming client does not request undeclared %s at all', async (_label, call, key) => {
        const result = (await call()) as Record<string, unknown[]>;
        expect(result[key]).toEqual([]);
    });

    // A non-conforming client can still put the request on the wire, which is
    // what the fallback handler is for. resources/* and prompts/* are not
    // policed yet (ARCHITECTURE.md OD-4), and a resource read can exfiltrate as
    // effectively as a tool call — so the honest answer is method-not-found,
    // never a quiet relay.
    it.each(['resources/list', 'prompts/list', 'completion/complete'])('rejects a raw %s request', async (method) => {
        await expect(client.request({ method, params: {} } as never)).rejects.toMatchObject({ code: -32601 });
    });

    it('names the rejected method in the error data', async () => {
        const error = (await client.request({ method: 'resources/list', params: {} } as never).catch((e: unknown) => e)) as {
            code: number;
            data?: { method?: string };
        };

        expect(error.code).toBe(-32601);
        // Verified against SDK 2.0.0: a thrown handler error propagates `code`
        // and `data`, so structured detail reaches the caller.
        expect(error.data?.method).toBe('resources/list');
    });
});
