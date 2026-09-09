/**
 * A minimal, deterministic MCP server used to exercise the Sentinel gateway.
 *
 * ## Why this exists
 *
 * ARCHITECTURE.md §23.3 requires integration tests to run against real MCP
 * servers rather than mocks. A mock would test our idea of the protocol; this
 * tests the protocol as the official SDK actually implements it.
 *
 * ## Scope
 *
 * Every tool here is a pure, side-effect-free function over its arguments. The
 * server holds no state between calls, so tests are order-independent and the
 * server can be spawned and killed freely.
 *
 * The deliberate failure tools (`fail_soft`, `fail_hard`, `slow`) exist so the
 * gateway's error and timeout paths can be tested against genuine upstream
 * behaviour instead of simulated conditions.
 *
 * NOT FOR PRODUCTION USE.
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Identity this demo server reports. Sentinel never trusts it for routing. */
export const DEMO_SERVER_INFO = {
    name: 'demo-basic-server',
    version: '0.1.0'
} as const;

/** Build a plain text tool result with the correct discriminated literal types. */
function textResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
}

export function createDemoServer(): McpServer {
    const server = new McpServer(DEMO_SERVER_INFO, {
        capabilities: { tools: {} }
    });

    server.registerTool(
        'echo',
        {
            title: 'Echo',
            description: 'Returns the message it was given.',
            inputSchema: { message: z.string() }
        },
        ({ message }): CallToolResult => textResult(message)
    );

    server.registerTool(
        'add',
        {
            title: 'Add',
            description: 'Adds two numbers and returns a structured result.',
            inputSchema: { a: z.number(), b: z.number() },
            outputSchema: { sum: z.number() }
        },
        ({ a, b }): CallToolResult => {
            const sum = a + b;
            return {
                // A tool returning structured content SHOULD also return the
                // serialized JSON as text, for backwards compatibility.
                content: [{ type: 'text', text: JSON.stringify({ sum }) }],
                structuredContent: { sum }
            };
        }
    );

    server.registerTool(
        'get_constant',
        {
            title: 'Get Constant',
            description: 'Returns a fixed string. Takes no parameters.',
            inputSchema: {}
        },
        (): CallToolResult => textResult('sentinel-demo-constant')
    );

    // A *tool execution* error: the call succeeded at the protocol level and
    // reports failure in-band via isError. Clients SHOULD pass these to the
    // model so it can self-correct. The gateway must relay this faithfully and
    // must NOT convert it into a protocol error.
    server.registerTool(
        'fail_soft',
        {
            title: 'Fail (in-band)',
            description: 'Always returns a tool execution error with isError: true.',
            inputSchema: {}
        },
        (): CallToolResult => ({
            content: [{ type: 'text', text: 'deliberate in-band tool failure' }],
            isError: true
        })
    );

    // A *protocol* error: the handler throws. The SDK converts this into a
    // JSON-RPC error response. The gateway must relay the failure without
    // leaking the upstream's internal detail downstream.
    server.registerTool(
        'fail_hard',
        {
            title: 'Fail (thrown)',
            description: 'Always throws, producing a JSON-RPC error response.',
            inputSchema: {}
        },
        (): CallToolResult => {
            throw new Error('deliberate thrown failure at upstream/demo/basic-server');
        }
    );

    server.registerTool(
        'slow',
        {
            title: 'Slow',
            description: 'Sleeps for the requested number of milliseconds before responding.',
            inputSchema: { ms: z.number().int().min(0).max(60_000) }
        },
        async ({ ms }): Promise<CallToolResult> => {
            await new Promise((resolve) => setTimeout(resolve, ms));
            return textResult(`slept ${ms}ms`);
        }
    );

    return server;
}
