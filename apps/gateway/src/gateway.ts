/**
 * The gateway core: Sentinel's downstream MCP server face.
 *
 * ## Responsibility
 *
 * Present a conformant MCP server to downstream callers, resolve each request
 * against the registry, and run it through the security pipeline.
 *
 * ## Shape
 *
 * `createMcpHandler` invokes a factory once per HTTP request, so a fresh
 * low-level `Server` is constructed per request. That is the 2026-07-28
 * stateless model: no session, no per-connection state, and therefore no
 * sticky-routing requirement when scaling horizontally.
 *
 * The long-lived collaborators — the registry and the pipeline — are captured
 * from the enclosing scope rather than rebuilt per request.
 *
 * ## Trust boundary
 *
 * Requests arriving here are untrusted (ARCHITECTURE.md §8.2, crossing 1).
 * Tool names are resolved by exact registry lookup, never by parsing the
 * caller's string into parts and trusting them.
 *
 * ## Phase 1 scope
 *
 * This checkpoint serves `tools/list` only. `tools/call` arrives in the next
 * checkpoint and currently falls through to the method-not-found path.
 */

import { Server, type ListToolsResult } from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';

import { JsonRpcErrorCode, SentinelError, type SecurityPipeline } from '@mcp-sentinel/protocol';

import type { Logger } from './logging.js';
import { type ToolRegistry, toDownstreamTool } from './registry.js';

/** Identity Sentinel presents to downstream callers. */
export const SENTINEL_SERVER_INFO = {
    name: 'mcp-sentinel',
    version: '0.1.0'
} as const;

export interface GatewayDeps {
    readonly registry: ToolRegistry;
    readonly pipeline: SecurityPipeline;
    readonly logger: Logger;
}

/**
 * Longest requested tool name echoed back in an error message.
 *
 * The name is caller-supplied and therefore untrusted. JSON encoding makes it
 * inert, but echoing an unbounded string would let a caller inflate error
 * responses and log lines at will.
 */
const MAX_ECHOED_NAME_LENGTH = 128;

function echoSafe(name: string): string {
    return name.length <= MAX_ECHOED_NAME_LENGTH ? name : `${name.slice(0, MAX_ECHOED_NAME_LENGTH)}…`;
}

/**
 * Build the per-request MCP server instance.
 *
 * Exported so tests can drive it over an in-memory transport rather than HTTP.
 */
export function createSentinelServer(deps: GatewayDeps): Server {
    const { registry, pipeline, logger } = deps;

    const server = new Server(SENTINEL_SERVER_INFO, {
        capabilities: { tools: {} }
    });

    server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => {
        const correlationId = randomUUID();
        const receivedAt = new Date();
        const requestLogger = logger.child({ correlationId, method: 'tools/list' });

        const visible = await pipeline.filterToolList({ correlationId, receivedAt }, registry.list());

        requestLogger.info('tools/list served', {
            total: registry.size,
            returned: visible.length,
            pipeline: pipeline.name,
            // Surfaced on every listing so the active posture is visible in
            // operation, not only in source. Phase 1 is deliberately false.
            enforcing: pipeline.enforcing
        });

        return { tools: visible.map(toDownstreamTool) };
    });

    /**
     * Anything Sentinel does not explicitly serve.
     *
     * Verified against SDK 2.0.0: an unhandled method already yields `-32601`
     * without this handler, so the fallback exists for observability — an
     * unexpected method arriving at the gateway is worth a log line — and to
     * name the method in the message rather than returning a bare
     * "Method not found".
     *
     * `resources/*` and `prompts/*` are deliberately NOT proxied yet
     * (ARCHITECTURE.md OD-4). Answering method-not-found is honest; silently
     * relaying them would expose an unpoliced surface, and a resource read can
     * exfiltrate as effectively as a tool call.
     */
    server.fallbackRequestHandler = (request) => {
        logger.warn('unsupported method', { method: request.method });
        return Promise.reject(
            new SentinelError(JsonRpcErrorCode.METHOD_NOT_FOUND, `Method not supported by this gateway: ${echoSafe(request.method)}`, {
                method: request.method
            })
        );
    };

    return server;
}
