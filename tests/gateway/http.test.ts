/**
 * End-to-end tests over real HTTP.
 *
 * These are the first tests that exercise the actual wire: a real
 * `StreamableHTTPClientTransport` talking to a real `node:http` listener, which
 * means they are also the first to exercise protocol-era negotiation. The
 * in-memory transport used by `gateway.test.ts` negotiates the 2025-era path
 * and therefore cannot cover this.
 *
 * The listener binds port 0 so suites can run without colliding.
 */

import { request } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { passThroughPipeline, type UpstreamServerConfig } from '@mcp-sentinel/protocol';

import { LOOPBACK_HOSTNAMES, type ListenConfig } from '../../apps/gateway/src/config.js';
import { startGatewayHttpServer, type GatewayHttpServer } from '../../apps/gateway/src/http.js';
import { ToolRegistry } from '../../apps/gateway/src/registry.js';
import { UpstreamPool } from '../../apps/gateway/src/upstream.js';
import { silentLogger } from '../../apps/gateway/src/logging.js';
import { DEMO_STDIO_ENTRY } from '../helpers/demoServer.js';

const upstreams: UpstreamServerConfig[] = [
    {
        id: 'srv-alpha',
        alias: 'alpha',
        transport: { kind: 'stdio', command: process.execPath, args: [DEMO_STDIO_ENTRY] },
        trustTier: 'VERIFIED',
        environment: 'dev'
    }
];

const listen: ListenConfig = {
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    allowedHosts: LOOPBACK_HOSTNAMES,
    allowedOrigins: LOOPBACK_HOSTNAMES
};

let pool: UpstreamPool;
let registry: ToolRegistry;
let http: GatewayHttpServer;
let baseUrl: string;

beforeAll(async () => {
    pool = new UpstreamPool(upstreams, silentLogger);
    expect(await pool.connectAll()).toEqual([]);

    registry = new ToolRegistry(silentLogger);
    await registry.refresh(pool, 20_000);

    http = await startGatewayHttpServer(
        {
            listen,
            deps: {
                registry,
                pool,
                pipeline: passThroughPipeline,
                logger: silentLogger,
                upstreamRequestTimeoutMs: 15_000
            },
            isReady: () => registry.size > 0
        },
        silentLogger
    );

    baseUrl = `http://127.0.0.1:${http.port}`;
}, 90_000);

afterAll(async () => {
    await http?.close();
    await pool?.closeAll();
});

/**
 * POST with a caller-chosen `Host` header.
 *
 * `fetch` refuses to set `Host` (it is a forbidden header name), so the DNS
 * rebinding guard cannot be reached through it.
 */
function rawPost(port: number, path: string, host: string, body: unknown): Promise<number> {
    return new Promise((resolvePromise, rejectPromise) => {
        const payload = JSON.stringify(body);
        const req = request(
            {
                host: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers: {
                    host,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    'content-length': Buffer.byteLength(payload)
                }
            },
            (res) => {
                res.resume();
                res.on('end', () => resolvePromise(res.statusCode ?? 0));
            }
        );
        req.on('error', rejectPromise);
        req.end(payload);
    });
}

async function connectClient(): Promise<Client> {
    const client = new Client(
        { name: 'e2e-client', version: '0.0.0' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    return client;
}

describe('operational endpoints', () => {
    it('reports liveness', async () => {
        const response = await fetch(`${baseUrl}/healthz`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
    });

    it('reports readiness separately from liveness', async () => {
        // A gateway that is alive but cannot serve should be removed from a
        // load balancer rather than left refusing every call.
        const response = await fetch(`${baseUrl}/readyz`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ready' });
    });

    it('returns 404 for an unknown path', async () => {
        expect((await fetch(`${baseUrl}/not-a-route`)).status).toBe(404);
    });
});

describe('transport conformance', () => {
    it('answers GET on the MCP endpoint with 405', async () => {
        // Protocol revision 2026-07-28 removed the standalone GET stream, so a
        // server implementing only this revision answers GET with 405.
        expect((await fetch(`${baseUrl}/mcp`)).status).toBe(405);
    });

    it('rejects a non-JSON content type before parsing a body', async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'not json'
        });

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });
});

describe('security invariant: DNS rebinding guards run before the handler', () => {
    // The MCP specification requires Origin validation; the SDK's handler is
    // documented as deliberately validation-free, so the guards are ours to
    // place in front of it.
    it('rejects a disallowed Origin with 403', async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });

        expect(response.status).toBe(403);
    });

    it('rejects a disallowed Host with 403', async () => {
        // `Host` is a forbidden header name in the Fetch standard, so `fetch`
        // silently drops an override and sends the URL's own host. Reaching
        // this guard at all requires a raw request.
        const status = await rawPost(http.port, '/mcp', 'attacker.example', {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
        });

        expect(status).toBe(403);
    });

    it('allows a loopback Origin', async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                origin: 'http://localhost'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });

        expect(response.status).not.toBe(403);
    });

    it('guards the operational endpoints too', async () => {
        const response = await fetch(`${baseUrl}/healthz`, { headers: { origin: 'http://evil.example' } });
        expect(response.status).toBe(403);
    });
});

describe('MCP over Streamable HTTP', () => {
    let client: Client;

    beforeAll(async () => {
        client = await connectClient();
    }, 60_000);

    afterAll(async () => {
        await client?.close();
    });

    it('serves the namespaced catalog over the wire', async () => {
        const names = (await client.listTools({}, { cacheMode: 'bypass' })).tools.map((t) => t.name).sort();

        expect(names).toContain('alpha__echo');
        expect(names).toHaveLength(6);
    });

    it('relays a tool call over the wire', async () => {
        const result = await client.callTool({ name: 'alpha__echo', arguments: { message: 'over http' } });
        expect(result.content).toEqual([{ type: 'text', text: 'over http' }]);
    });

    it('relays structured content over the wire', async () => {
        const result = await client.callTool({ name: 'alpha__add', arguments: { a: 20, b: 22 } });
        expect(result.structuredContent).toEqual({ sum: 42 });
    });

    it('relays an in-band tool error over the wire', async () => {
        const result = await client.callTool({ name: 'alpha__fail_soft', arguments: {} });
        expect(result.isError).toBe(true);
    });

    it('rejects an unknown tool over the wire', async () => {
        await expect(client.callTool({ name: 'alpha__nope', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    });

    it('serves independent requests without any session state', async () => {
        // 2026-07-28 removed protocol sessions. A second client sharing no
        // state with the first must work identically, which is what makes
        // horizontal scaling without sticky routing possible.
        const second = await connectClient();
        try {
            const result = await second.callTool({ name: 'alpha__echo', arguments: { message: 'independent' } });
            expect(result.content).toEqual([{ type: 'text', text: 'independent' }]);
        } finally {
            await second.close();
        }
    }, 60_000);
});
