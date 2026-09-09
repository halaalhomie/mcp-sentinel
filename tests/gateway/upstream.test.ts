/**
 * Integration tests for the upstream client, against a REAL MCP server.
 *
 * These spawn the demo server as a child process over stdio. Nothing is
 * mocked: a mock would only confirm our assumptions about the protocol,
 * whereas this exercises the official SDK's actual behaviour.
 *
 * One connection is shared across the suite. Spawning a Node child process and
 * warming the SDK's schema validators costs several seconds on Windows, and
 * paying that per test made the suite take two minutes for no extra coverage.
 * The demo server is stateless, so sharing is safe.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SentinelError, SentinelErrorCode, type UpstreamServerConfig } from '@mcp-sentinel/protocol';
import { UpstreamConnection } from '../../apps/gateway/src/upstream.js';
import { silentLogger } from '../../apps/gateway/src/logging.js';
import { DEMO_STDIO_ENTRY, DEMO_TOOL_NAMES } from '../helpers/demoServer.js';

const stdioConfig: UpstreamServerConfig = {
    id: 'srv-demo',
    alias: 'demo',
    transport: { kind: 'stdio', command: process.execPath, args: [DEMO_STDIO_ENTRY] },
    trustTier: 'VERIFIED',
    environment: 'dev'
};

const REQUEST = { timeoutMs: 15_000 } as const;

let upstream: UpstreamConnection;

beforeAll(async () => {
    upstream = new UpstreamConnection(stdioConfig, silentLogger);
    await upstream.connect();
    // Warm the SDK's lazily-compiled validators so per-test timings are not
    // dominated by first-request cost.
    await upstream.listTools(REQUEST);
});

afterAll(async () => {
    await upstream?.close();
});

describe('upstream connection over stdio', () => {
    it('discovers the server tools', async () => {
        const result = await upstream.listTools(REQUEST);
        const names = (result.tools ?? []).map((t) => t.name).sort();

        expect(names).toEqual([...DEMO_TOOL_NAMES]);
    });

    it('preserves tool metadata verbatim', async () => {
        const result = await upstream.listTools(REQUEST);
        const echo = (result.tools ?? []).find((t) => t.name === 'echo');

        expect(echo?.description).toBe('Returns the message it was given.');
        expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    });

    it('calls a tool and returns its result', async () => {
        const result = await upstream.callTool('echo', { message: 'hello sentinel' }, REQUEST);

        expect(result.content).toEqual([{ type: 'text', text: 'hello sentinel' }]);
        expect(result.isError).toBeFalsy();
    });

    it('relays structured content', async () => {
        const result = await upstream.callTool('add', { a: 2, b: 40 }, REQUEST);
        expect(result.structuredContent).toEqual({ sum: 42 });
    });

    it('relays an in-band tool error without converting it to a protocol error', async () => {
        // isError: true is a TOOL EXECUTION error: a successful protocol
        // exchange reporting a failed operation. Clients SHOULD pass these to
        // the model so it can self-correct, so turning one into a thrown
        // protocol error would destroy information the caller needs.
        const result = await upstream.callTool('fail_soft', {}, REQUEST);

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: 'deliberate in-band tool failure' }]);
    });

    it('surfaces a thrown upstream handler as an in-band error, matching SDK behaviour', async () => {
        // Verified against SDK 2.0.0: McpServer catches a thrown handler and
        // converts it into isError: true rather than a JSON-RPC error.
        const result = await upstream.callTool('fail_hard', {}, REQUEST);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('deliberate thrown failure');
    });
});

describe('upstream failure handling', () => {
    it('reports UPSTREAM_UNAVAILABLE when not connected', async () => {
        const disconnected = new UpstreamConnection(stdioConfig, silentLogger);

        await expect(disconnected.callTool('echo', {}, { timeoutMs: 1_000 })).rejects.toMatchObject({
            code: SentinelErrorCode.UPSTREAM_UNAVAILABLE
        });
    });

    it('reports UPSTREAM_PROTOCOL_ERROR for an unknown tool', async () => {
        // The upstream answers with JSON-RPC -32602 "Tool ... not found".
        await expect(upstream.callTool('no_such_tool', {}, REQUEST)).rejects.toMatchObject({
            code: SentinelErrorCode.UPSTREAM_PROTOCOL_ERROR
        });
    });

    it('reports UPSTREAM_TIMEOUT and does not retry', async () => {
        const error = await upstream.callTool('slow', { ms: 5_000 }, { timeoutMs: 250 }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SentinelError);
        expect((error as SentinelError).code).toBe(SentinelErrorCode.UPSTREAM_TIMEOUT);
        // The outcome of a timed-out call is genuinely unknown: MCP gives no
        // idempotency guarantee, so Sentinel must not retry and must say so.
        expect((error as SentinelError).details['outcome']).toBe('UNKNOWN_OUTCOME');
    });

    it('stays usable after a timeout', async () => {
        // A timed-out request must not poison the connection for later calls.
        const result = await upstream.callTool('echo', { message: 'still alive' }, REQUEST);
        expect(result.content).toEqual([{ type: 'text', text: 'still alive' }]);
    });
});

describe('security invariant: Sentinel error detail does not leak upstream internals', () => {
    it('returns a generic message for an upstream protocol error', async () => {
        const error = (await upstream.callTool('no_such_tool', {}, REQUEST).catch((e: unknown) => e)) as SentinelError;

        expect(error).toBeInstanceOf(SentinelError);
        expect(error.publicMessage).toBe('The upstream server returned an error.');
        // The upstream's own wording is logged, not returned.
        expect(error.publicMessage).not.toContain('no_such_tool');
    });

    it('exposes only the operator-assigned alias, never transport detail', async () => {
        const error = (await upstream.callTool('no_such_tool', {}, REQUEST).catch((e: unknown) => e)) as SentinelError;
        const serialized = JSON.stringify({ message: error.publicMessage, details: error.details });

        expect(error.details['serverAlias']).toBe('demo');
        // The child process path and executable are transport detail.
        expect(serialized).not.toContain(DEMO_STDIO_ENTRY);
        expect(serialized).not.toContain('node.exe');
        expect(serialized).not.toContain(process.execPath);
    });
});
