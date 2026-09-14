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
 * `tools/list` and `tools/call` are served. Everything else answers
 * method-not-found; see the fallback handler for why.
 */

import { Server, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';

import { JsonRpcErrorCode, SentinelError, SentinelErrorCode, type SecurityPipeline } from '@mcp-sentinel/protocol';

import type { Logger } from './logging.js';
import { type ToolRegistry, toDownstreamTool } from './registry.js';
import type { UpstreamPool } from './upstream.js';

/** Identity Sentinel presents to downstream callers. */
export const SENTINEL_SERVER_INFO = {
    name: 'mcp-sentinel',
    version: '0.1.0'
} as const;

export interface GatewayDeps {
    readonly registry: ToolRegistry;
    readonly pool: UpstreamPool;
    readonly pipeline: SecurityPipeline;
    readonly logger: Logger;
    /** Per-request upstream budget. On expiry the call is abandoned, never retried. */
    readonly upstreamRequestTimeoutMs: number;
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
    const { registry, pool, pipeline, logger, upstreamRequestTimeoutMs } = deps;

    /*
     * The SDK marks the low-level `Server` deprecated in favour of `McpServer`,
     * adding "Only use `Server` for advanced use cases." A proxy is one.
     *
     * `McpServer.registerTool` expects each tool to be declared up front with a
     * schema it owns, which would force Sentinel to translate every upstream
     * JSON Schema into the SDK's schema type and re-emit it. That would break
     * the guarantee that `inputSchema` and `outputSchema` reach the caller
     * exactly as the upstream sent them, and would silently rewrite the bytes
     * Phase 2 intends to fingerprint. It also does not fit a catalog that is
     * discovered at runtime and changes when an upstream changes.
     *
     * `Server` lets the gateway forward a request without interpreting it, so
     * that is the correct trade here.
     */
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

    server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
        const correlationId = randomUUID();
        const receivedAt = new Date();
        const requestedName = request.params.name;
        const requestLogger = logger.child({ correlationId, method: 'tools/call' });

        // Exact registry lookup. A caller-supplied name is never split into
        // parts and trusted; an unknown name simply has no route.
        //
        // -32602 matches what a conforming MCP server returns for an unknown
        // tool, so a caller cannot distinguish "Sentinel does not know this
        // tool" from "the upstream does not expose it" — which is the correct
        // amount of information to give.
        const tool = registry.resolve(requestedName);
        if (tool === undefined) {
            requestLogger.warn('unknown tool requested', { requestedName: JSON.stringify(requestedName) });
            throw new SentinelError(JsonRpcErrorCode.INVALID_PARAMS, `Unknown tool: ${echoSafe(requestedName)}`, { correlationId });
        }

        const toolLogger = requestLogger.child({
            serverAlias: tool.serverAlias,
            tool: tool.qualifiedName
        });

        // The decision is made BEFORE any upstream contact. A DENY must never
        // be able to produce a side effect, so nothing below this point runs
        // until the pipeline has allowed the call.
        const decision = await pipeline.evaluateToolCall({
            correlationId,
            serverId: tool.serverId,
            serverAlias: tool.serverAlias,
            upstreamName: tool.upstreamName,
            qualifiedName: tool.qualifiedName,
            args: request.params.arguments,
            receivedAt
        });

        if (decision.effect === 'DENY') {
            toolLogger.warn('tool call denied', { source: decision.source, reason: decision.reason });
            throw new SentinelError(decision.code, decision.reason, { correlationId, source: decision.source });
        }

        const connection = pool.get(tool.serverId);
        if (connection === undefined) {
            // Registry and pool are built from the same configuration, so this
            // is unreachable in practice. Fail closed rather than assume.
            toolLogger.error('no upstream connection for a registered tool', { serverId: tool.serverId });
            throw new SentinelError(SentinelErrorCode.UPSTREAM_UNAVAILABLE, 'The upstream server is not available.', {
                correlationId,
                serverAlias: tool.serverAlias
            });
        }

        const startedAt = Date.now();
        const result = await connection.callTool(tool.upstreamName, request.params.arguments, {
            timeoutMs: upstreamRequestTimeoutMs
        });

        toolLogger.info('tool call relayed', {
            upstreamName: tool.upstreamName,
            upstreamLatencyMs: Date.now() - startedAt,
            // The upstream's in-band execution status, relayed rather than
            // interpreted. An isError result is a successful protocol exchange
            // reporting a failed operation, and the caller needs to see it.
            isError: result.isError === true,
            pipeline: pipeline.name,
            enforcing: pipeline.enforcing
        });

        // Returned unmodified. Sentinel does not rewrite tool results: a tool
        // may declare an outputSchema that servers MUST satisfy and clients
        // SHOULD validate, so editing a payload here could produce a response
        // that violates the tool's own contract (ARCHITECTURE.md §17.6).
        return result;
    });

    /*
     * There is deliberately NO `fallbackRequestHandler`.
     *
     * An earlier version installed one to log unsupported methods and name the
     * method in the error. Differential conformance caught what that cost:
     * the check `sep-2575-http-server-method-not-found-404` passed against the
     * upstream directly and FAILED through Sentinel.
     *
     * The cause is that the SDK distinguishes "no handler is registered for
     * this method" from "a handler ran and threw". The first produces
     * `404 Not Found` with JSON-RPC `-32601`, which is what the specification
     * requires of a server that does not implement a method. The second
     * produces `200` carrying a JSON-RPC error. Installing a fallback turned
     * every unimplemented method into the second case.
     *
     * Leaving the method unregistered restores the required behaviour. The lost
     * log line is not worth a spec violation, and the gateway was never
     * depending on the fallback for correctness — verified separately against
     * SDK 2.0.0, an unhandled method already yields `-32601` on its own.
     *
     * `resources/*` and `prompts/*` therefore answer method-not-found, which is
     * the honest response while they are unpoliced (ARCHITECTURE.md OD-4): a
     * resource read can exfiltrate as effectively as a tool call, so silently
     * relaying them would expose a surface nothing is checking.
     */

    return server;
}
