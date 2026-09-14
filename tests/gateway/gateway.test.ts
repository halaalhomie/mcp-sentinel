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

import { SentinelErrorCode, passThroughPipeline, type SecurityPipeline, type UpstreamServerConfig } from '@mcp-sentinel/protocol';
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

const UPSTREAM_TIMEOUT_MS = 15_000;

/** Connect a downstream client to a gateway built with the given pipeline. */
async function connectClient(pipeline: SecurityPipeline = passThroughPipeline, upstreamRequestTimeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Client> {
    const server = createSentinelServer({ registry, pool, pipeline, logger: silentLogger, upstreamRequestTimeoutMs });
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
        const result = await client.listTools({}, { cacheMode: 'bypass' });
        const names = result.tools.map((t) => t.name).sort();

        expect(names).toHaveLength(12);
        expect(names).toContain('alpha__add');
        expect(names).toContain('beta__slow');
    });

    it('rewrites the name and nothing else', async () => {
        const result = await client.listTools({}, { cacheMode: 'bypass' });
        const echo = result.tools.find((t) => t.name === 'alpha__echo');

        expect(echo).toBeDefined();
        // Description and schema must arrive exactly as the upstream sent them.
        expect(echo?.description).toBe('Returns the message it was given.');
        expect(echo?.title).toBe('Echo');
        expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    });

    it('preserves an upstream outputSchema', async () => {
        const result = await client.listTools({}, { cacheMode: 'bypass' });
        const add = result.tools.find((t) => t.name === 'alpha__add');

        expect(add?.outputSchema).toMatchObject({ type: 'object' });
    });
});

describe('tools/call relay', () => {
    let client: Client;

    beforeAll(async () => {
        client = await connectClient();
    });

    afterAll(async () => {
        await client?.close();
    });

    it('routes a call to the correct upstream and returns its result', async () => {
        const result = await client.callTool({ name: 'alpha__echo', arguments: { message: 'through the gateway' } });

        expect(result.content).toEqual([{ type: 'text', text: 'through the gateway' }]);
        expect(result.isError).toBeFalsy();
    });

    it('routes by alias, so identically-named tools stay distinct', async () => {
        // Both upstreams expose `echo`. The alias is the only thing separating
        // them, and it must actually determine the route.
        const alpha = await client.callTool({ name: 'alpha__echo', arguments: { message: 'a' } });
        const beta = await client.callTool({ name: 'beta__echo', arguments: { message: 'b' } });

        expect(alpha.content).toEqual([{ type: 'text', text: 'a' }]);
        expect(beta.content).toEqual([{ type: 'text', text: 'b' }]);
    });

    it('relays structured content unmodified', async () => {
        const result = await client.callTool({ name: 'beta__add', arguments: { a: 19, b: 23 } });
        expect(result.structuredContent).toEqual({ sum: 42 });
    });

    it('relays an in-band tool error faithfully', async () => {
        // isError: true is a successful protocol exchange reporting a failed
        // operation. Clients SHOULD hand these to the model so it can
        // self-correct, so converting one into a protocol error would destroy
        // information the caller needs.
        const result = await client.callTool({ name: 'alpha__fail_soft', arguments: {} });

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: 'deliberate in-band tool failure' }]);
    });

    it('rejects a tool the gateway does not expose', async () => {
        await expect(client.callTool({ name: 'alpha__no_such_tool', arguments: {} })).rejects.toMatchObject({
            code: -32602
        });
    });

    it('rejects an unqualified tool name', async () => {
        // `echo` exists upstream but is never exposed unqualified, so it must
        // not resolve. This is the routing-confusion case in miniature.
        await expect(client.callTool({ name: 'echo', arguments: { message: 'x' } })).rejects.toMatchObject({
            code: -32602
        });
    });

    it('rejects a name for an alias that does not exist', async () => {
        await expect(client.callTool({ name: 'gamma__echo', arguments: { message: 'x' } })).rejects.toMatchObject({
            code: -32602
        });
    });

    it('reports an upstream timeout without retrying', async () => {
        const impatient = await connectClient(passThroughPipeline, 250);
        try {
            const error = (await impatient.callTool({ name: 'alpha__slow', arguments: { ms: 5_000 } }).catch((e: unknown) => e)) as {
                code: number;
                data?: { outcome?: string };
            };

            expect(error.code).toBe(SentinelErrorCode.UPSTREAM_TIMEOUT);
            // MCP gives no idempotency guarantee, so the honest answer is that
            // the outcome is unknown — not a silent retry.
            expect(error.data?.outcome).toBe('UNKNOWN_OUTCOME');
        } finally {
            await impatient.close();
        }
    });
});

describe('security invariant: a denied call never reaches the upstream', () => {
    /** A pipeline that denies one specific tool and records every call it sees. */
    function denyingPipeline(denyQualifiedName: string): { pipeline: SecurityPipeline; seen: string[] } {
        const seen: string[] = [];
        const pipeline: SecurityPipeline = {
            name: 'test-deny-one',
            enforcing: true,
            evaluateToolCall: (ctx) => {
                seen.push(ctx.qualifiedName);
                return Promise.resolve(
                    ctx.qualifiedName === denyQualifiedName
                        ? { effect: 'DENY', code: SentinelErrorCode.POLICY_DENIED, reason: 'Denied by test policy.', source: 'test-rule' }
                        : { effect: 'ALLOW' }
                );
            },
            filterToolList: (_ctx, tools) => Promise.resolve(tools)
        };
        return { pipeline, seen };
    }

    it('returns the decision code and reason to the caller', async () => {
        const { pipeline } = denyingPipeline('alpha__echo');
        const client = await connectClient(pipeline);
        try {
            const error = (await client.callTool({ name: 'alpha__echo', arguments: { message: 'x' } }).catch((e: unknown) => e)) as {
                code: number;
                message: string;
                data?: { source?: string; correlationId?: string };
            };

            expect(error.code).toBe(SentinelErrorCode.POLICY_DENIED);
            expect(error.message).toBe('Denied by test policy.');
            // A denial must be explainable: the caller learns which rule fired
            // and gets a correlation id to quote when asking why.
            expect(error.data?.source).toBe('test-rule');
            expect(error.data?.correlationId).toEqual(expect.any(String));
        } finally {
            await client.close();
        }
    });

    it('does not produce the upstream side effect', async () => {
        // `echo` is observable only through its return value, so a denied call
        // proving it returned nothing is the available evidence that the
        // upstream was never asked.
        const { pipeline, seen } = denyingPipeline('alpha__echo');
        const client = await connectClient(pipeline);
        try {
            await expect(client.callTool({ name: 'alpha__echo', arguments: { message: 'x' } })).rejects.toBeDefined();
            expect(seen).toEqual(['alpha__echo']);

            // The same pipeline still permits a different tool, so the denial
            // is specific rather than a blanket failure.
            const allowed = await client.callTool({ name: 'beta__echo', arguments: { message: 'ok' } });
            expect(allowed.content).toEqual([{ type: 'text', text: 'ok' }]);
        } finally {
            await client.close();
        }
    });

    it('consults the pipeline before resolving the upstream, for every call', async () => {
        const { pipeline, seen } = denyingPipeline('nothing__matches');
        const client = await connectClient(pipeline);
        try {
            await client.callTool({ name: 'alpha__get_constant', arguments: {} });
            await client.callTool({ name: 'beta__get_constant', arguments: {} });

            expect(seen).toEqual(['alpha__get_constant', 'beta__get_constant']);
        } finally {
            await client.close();
        }
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
            const names = (await client.listTools({}, { cacheMode: 'bypass' })).tools.map((t) => t.name);

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
            expect((await client.listTools({}, { cacheMode: 'bypass' })).tools).toEqual([]);
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
        ['resources', () => client.listResources({}, { cacheMode: 'bypass' }), 'resources'],
        ['prompts', () => client.listPrompts({}, { cacheMode: 'bypass' }), 'prompts']
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

    it('uses the SDK native method-not-found path rather than a fallback handler', async () => {
        // The gateway deliberately registers no fallbackRequestHandler. The SDK
        // distinguishes "no handler registered" (404 + -32601, which the spec
        // requires) from "a handler threw" (200 + JSON-RPC error). A fallback
        // turned every unimplemented method into the second case and failed the
        // conformance check sep-2575-http-server-method-not-found-404.
        const error = (await client.request({ method: 'resources/list', params: {} } as never).catch((e: unknown) => e)) as {
            code: number;
            message?: string;
        };

        expect(error.code).toBe(-32601);
        expect(error.message).toMatch(/method not found/i);
    });
});
