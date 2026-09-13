/**
 * Resilience: what the gateway does when things go wrong.
 *
 * Covers the failure paths the earlier suites deliberately avoided — an
 * upstream that never starts, an upstream that dies while the gateway is
 * running, malformed requests from downstream, and a caller that disconnects
 * mid-flight.
 *
 * These use real processes throughout: a real stdio child, a real HTTP child
 * that gets killed, and a real listener. Simulating a crash would only test
 * our idea of what a crash looks like.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SentinelErrorCode, passThroughPipeline, type UpstreamServerConfig } from '@mcp-sentinel/protocol';

import { LOOPBACK_HOSTNAMES, type ListenConfig } from '../../apps/gateway/src/config.js';
import { startGatewayHttpServer, type GatewayHttpServer } from '../../apps/gateway/src/http.js';
import { ToolRegistry } from '../../apps/gateway/src/registry.js';
import { UpstreamPool } from '../../apps/gateway/src/upstream.js';
import { silentLogger } from '../../apps/gateway/src/logging.js';
import { DEMO_STDIO_ENTRY } from '../helpers/demoServer.js';
import { spawnHttpDemo, type SpawnedHttpDemo } from '../helpers/spawnHttpDemo.js';

const stdioUpstream = (id: string, alias: string): UpstreamServerConfig => ({
    id,
    alias,
    transport: { kind: 'stdio', command: process.execPath, args: [DEMO_STDIO_ENTRY] },
    trustTier: 'VERIFIED',
    environment: 'dev'
});

const listen: ListenConfig = {
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    allowedHosts: LOOPBACK_HOSTNAMES,
    allowedOrigins: LOOPBACK_HOSTNAMES
};

describe('upstream that never starts', () => {
    let pool: UpstreamPool;
    let registry: ToolRegistry;

    beforeAll(async () => {
        pool = new UpstreamPool(
            [
                stdioUpstream('srv-good', 'good'),
                {
                    id: 'srv-missing',
                    alias: 'missing',
                    // A command that does not exist. The transport cannot spawn it.
                    transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-xyz', args: [] },
                    trustTier: 'UNTRUSTED',
                    environment: 'dev'
                }
            ],
            silentLogger
        );

        await pool.connectAll();

        registry = new ToolRegistry(silentLogger);
        await registry.refresh(pool, 15_000);
    }, 90_000);

    afterAll(async () => {
        await pool?.closeAll();
    });

    it('reports the failure without throwing', async () => {
        // connectAll resolves with the ids that failed rather than rejecting,
        // so one bad upstream cannot abort startup (ARCHITECTURE.md NFR-R2).
        const failures = await new UpstreamPool(
            [{ id: 'x', alias: 'x', transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-xyz', args: [] }, trustTier: 'UNTRUSTED', environment: 'dev' }],
            silentLogger
        ).connectAll();

        expect(failures).toEqual(['x']);
    });

    it('still serves the healthy upstream', () => {
        const names = registry.list().map((t) => t.qualifiedName);

        expect(names).toContain('good__echo');
        expect(names.every((n) => n.startsWith('good__'))).toBe(true);
    });

    it('exposes no tools for the dead upstream', () => {
        expect(registry.list().some((t) => t.serverAlias === 'missing')).toBe(false);
    });

    it('refuses a call to a tool that was never registered', async () => {
        expect(registry.resolve('missing__echo')).toBeUndefined();
    });
});

describe('upstream over HTTP, and what happens when it dies', () => {
    let demo: SpawnedHttpDemo;
    let pool: UpstreamPool;
    let registry: ToolRegistry;
    let http: GatewayHttpServer;
    let client: Client;

    beforeAll(async () => {
        demo = await spawnHttpDemo();

        pool = new UpstreamPool(
            [
                stdioUpstream('srv-local', 'local'),
                { id: 'srv-remote', alias: 'remote', transport: { kind: 'http', url: demo.url }, trustTier: 'VERIFIED', environment: 'dev' }
            ],
            silentLogger
        );
        expect(await pool.connectAll()).toEqual([]);

        registry = new ToolRegistry(silentLogger);
        await registry.refresh(pool, 15_000);

        http = await startGatewayHttpServer(
            {
                listen,
                deps: { registry, pool, pipeline: passThroughPipeline, logger: silentLogger, upstreamRequestTimeoutMs: 8_000 },
                isReady: () => registry.size > 0
            },
            silentLogger
        );

        client = new Client({ name: 'resilience-client', version: '0.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`)));
    }, 120_000);

    afterAll(async () => {
        await client?.close();
        await http?.close();
        await pool?.closeAll();
        demo?.kill();
    });

    it('discovers tools from both stdio and HTTP upstreams', () => {
        const aliases = new Set(registry.list().map((t) => t.serverAlias));
        expect(aliases).toEqual(new Set(['local', 'remote']));
    });

    it('relays a call to an HTTP upstream', async () => {
        const result = await client.callTool({ name: 'remote__echo', arguments: { message: 'via http upstream' } });
        expect(result.content).toEqual([{ type: 'text', text: 'via http upstream' }]);
    });

    it('fails cleanly once the HTTP upstream is killed', async () => {
        demo.kill();
        // Give the OS a moment to actually tear the listener down.
        await new Promise((r) => setTimeout(r, 1_000));

        const error = (await client.callTool({ name: 'remote__echo', arguments: { message: 'gone' } }).catch((e: unknown) => e)) as {
            code?: number;
        };

        // The shape matters more than the exact code: it must be one of
        // Sentinel's upstream errors, not a hang and not a leaked stack trace.
        expect([SentinelErrorCode.UPSTREAM_UNAVAILABLE, SentinelErrorCode.UPSTREAM_TIMEOUT, SentinelErrorCode.UPSTREAM_PROTOCOL_ERROR]).toContain(
            error.code
        );
    }, 60_000);

    it('keeps serving the surviving upstream after the other dies', async () => {
        // Failure isolation is the point: one dead upstream must not take the
        // gateway, or its healthy siblings, down with it.
        const result = await client.callTool({ name: 'local__echo', arguments: { message: 'still here' } });
        expect(result.content).toEqual([{ type: 'text', text: 'still here' }]);
    }, 60_000);

    it('still serves the catalog after an upstream dies', async () => {
        const names = (await client.listTools({}, { cacheMode: 'bypass' })).tools.map((t) => t.name);
        expect(names).toContain('local__echo');
    });
});

describe('malformed downstream requests', () => {
    let pool: UpstreamPool;
    let registry: ToolRegistry;
    let http: GatewayHttpServer;
    let endpoint: string;

    beforeAll(async () => {
        pool = new UpstreamPool([stdioUpstream('srv-a', 'alpha')], silentLogger);
        expect(await pool.connectAll()).toEqual([]);

        registry = new ToolRegistry(silentLogger);
        await registry.refresh(pool, 15_000);

        http = await startGatewayHttpServer(
            {
                listen,
                deps: { registry, pool, pipeline: passThroughPipeline, logger: silentLogger, upstreamRequestTimeoutMs: 8_000 },
                isReady: () => true
            },
            silentLogger
        );
        endpoint = `http://127.0.0.1:${http.port}/mcp`;
    }, 90_000);

    afterAll(async () => {
        await http?.close();
        await pool?.closeAll();
    });

    const post = (body: string, contentType = 'application/json') =>
        fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': contentType, accept: 'application/json, text/event-stream' },
            body
        });

    it.each([
        ['invalid JSON', '{ not json'],
        ['an empty body', ''],
        ['a JSON array', '[]'],
        ['a bare string', '"hello"'],
        ['a request with no method', JSON.stringify({ jsonrpc: '2.0', id: 1 })],
        ['a wrong jsonrpc version', JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'tools/list', params: {} })]
    ])('rejects %s without a 5xx', async (_label, body) => {
        const response = await post(body);

        // Malformed input is the caller's fault. A 5xx would mean Sentinel
        // treated a bad request as its own internal failure.
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });

    it('handles a deeply nested payload without failing', async () => {
        // Deep nesting inside an ignored `params` field is not itself invalid,
        // and this request is correctly answered with 200. The property worth
        // asserting is that it neither hangs nor produces a 5xx.
        //
        // NOTE: Phase 1 does NOT bound request body depth. ARCHITECTURE.md
        // §17.4 requires bounded parsing, but that requirement is written
        // against tool `inputSchema` validation, which does not exist yet.
        // A body-size and depth limit belongs with it and is not implemented.
        const nested = JSON.parse('['.repeat(200) + ']'.repeat(200)) as unknown;
        const response = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { ignored: nested } }));

        expect(response.status).toBeLessThan(500);
    });

    it('survives a burst of malformed requests and still serves', async () => {
        await Promise.all(Array.from({ length: 25 }, () => post('{ garbage')));

        // The listener must still be healthy afterwards; a parser that can be
        // wedged by bad input is a denial-of-service vector.
        const client = new Client({ name: 'after-garbage', version: '0.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        try {
            const result = await client.callTool({ name: 'alpha__echo', arguments: { message: 'alive' } });
            expect(result.content).toEqual([{ type: 'text', text: 'alive' }]);
        } finally {
            await client.close();
        }
    }, 60_000);
});

describe('downstream disconnection', () => {
    let pool: UpstreamPool;
    let registry: ToolRegistry;
    let http: GatewayHttpServer;
    let endpoint: string;

    beforeAll(async () => {
        pool = new UpstreamPool([stdioUpstream('srv-a', 'alpha')], silentLogger);
        expect(await pool.connectAll()).toEqual([]);

        registry = new ToolRegistry(silentLogger);
        await registry.refresh(pool, 15_000);

        http = await startGatewayHttpServer(
            {
                listen,
                deps: { registry, pool, pipeline: passThroughPipeline, logger: silentLogger, upstreamRequestTimeoutMs: 20_000 },
                isReady: () => true
            },
            silentLogger
        );
        endpoint = `http://127.0.0.1:${http.port}/mcp`;
    }, 90_000);

    afterAll(async () => {
        await http?.close();
        await pool?.closeAll();
    });

    it('survives a caller aborting mid-request', async () => {
        const controller = new AbortController();

        const inFlight = fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'alpha__slow', arguments: { ms: 5_000 } }
            }),
            signal: controller.signal
        });

        // Abort while the upstream is still working. Under 2026-07-28 a closed
        // response stream IS the cancellation signal, so the gateway must cope
        // with the caller vanishing rather than treating it as an error.
        setTimeout(() => controller.abort(), 300);
        await expect(inFlight).rejects.toThrow();

        // The listener must remain usable for everyone else.
        const client = new Client({ name: 'after-abort', version: '0.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        try {
            const result = await client.callTool({ name: 'alpha__echo', arguments: { message: 'unaffected' } });
            expect(result.content).toEqual([{ type: 'text', text: 'unaffected' }]);
        } finally {
            await client.close();
        }
    }, 60_000);
});
