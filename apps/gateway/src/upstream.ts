/**
 * Upstream MCP connections.
 *
 * ## Responsibility
 *
 * Own one `Client` per configured upstream server, and be the single place
 * where Sentinel talks to something it does not trust.
 *
 * ## Trust boundary
 *
 * This module sits on crossing ❷/❸ of ARCHITECTURE.md §8.2. Everything
 * returned by an upstream is untrusted data. Failures are translated into
 * SentinelErrors carrying messages we wrote, so upstream hostnames, stack
 * traces and internal paths cannot reach a downstream caller (§17.5).
 *
 * ## Phase 1 scope
 *
 * Connections are established eagerly at startup and held. There is no
 * reconnect loop, no circuit breaker and no health probing — those are Phase 6
 * concerns. A dead upstream produces an honest error per request.
 */

import { Client, StreamableHTTPClientTransport, type ListToolsResult, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { SentinelError, SentinelErrorCode, type UpstreamServerConfig } from '@mcp-sentinel/protocol';

import type { Logger } from './logging.js';

/** Identity Sentinel reports to upstream servers. */
export const SENTINEL_CLIENT_INFO = {
    name: 'mcp-sentinel',
    version: '0.1.0'
} as const;

export interface UpstreamRequestOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

/**
 * A live connection to one upstream MCP server.
 */
export class UpstreamConnection {
    readonly config: UpstreamServerConfig;
    private readonly client: Client;
    private readonly logger: Logger;
    private connected = false;

    constructor(config: UpstreamServerConfig, logger: Logger) {
        this.config = config;
        this.logger = logger.child({ serverAlias: config.alias, serverId: config.id });

        this.client = new Client(SENTINEL_CLIENT_INFO, {
            capabilities: {},
            // The SDK defaults versionNegotiation.mode to 'legacy', which would
            // keep Sentinel on the 2025-era handshake. 'auto' probes for
            // 2026-07-28 and falls back only if the upstream cannot speak it.
            versionNegotiation: { mode: 'auto' }
        });
    }

    get alias(): string {
        return this.config.alias;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const transport = this.createTransport();
        await this.client.connect(transport);
        this.connected = true;
        this.logger.info('upstream connected', { transport: this.config.transport.kind });
    }

    private createTransport() {
        const { transport } = this.config;

        if (transport.kind === 'stdio') {
            // command and args are passed separately; there is no shell.
            // The SDK's getDefaultEnvironment() returns only variables deemed
            // safe to inherit, so the child does not receive the gateway's
            // whole environment (and therefore not its secrets) by default.
            return new StdioClientTransport({
                command: transport.command,
                args: [...transport.args],
                env: { ...getDefaultEnvironment(), ...(transport.env ?? {}) },
                ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
                stderr: 'pipe'
            });
        }

        return new StreamableHTTPClientTransport(new URL(transport.url));
    }

    /**
     * Wrap an upstream call, translating every failure mode into a
     * SentinelError with a caller-safe message.
     */
    private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
        if (!this.connected) {
            throw new SentinelError(SentinelErrorCode.UPSTREAM_UNAVAILABLE, 'The upstream server is not available.', {
                serverAlias: this.config.alias
            });
        }

        try {
            return await fn();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            const timedOut = /timed? ?out/i.test(message) || (cause as { code?: unknown } | null)?.code === 'ETIMEDOUT';

            // Logged with full detail; returned with none.
            this.logger.warn('upstream call failed', { operation, timedOut, detail: message });

            if (timedOut) {
                throw new SentinelError(
                    SentinelErrorCode.UPSTREAM_TIMEOUT,
                    'The upstream server did not respond within the configured budget. The outcome of this call is unknown and it was not retried.',
                    { serverAlias: this.config.alias, outcome: 'UNKNOWN_OUTCOME' },
                    { cause }
                );
            }

            throw new SentinelError(
                SentinelErrorCode.UPSTREAM_PROTOCOL_ERROR,
                'The upstream server returned an error.',
                { serverAlias: this.config.alias },
                { cause }
            );
        }
    }

    /**
     * List the upstream's tools.
     *
     * Safe to retry: `tools/list` is read-only by protocol definition. Phase 1
     * does not retry anyway, but the distinction from callTool is deliberate.
     */
    async listTools(options: UpstreamRequestOptions): Promise<ListToolsResult> {
        return this.guard('tools/list', () =>
            this.client.listTools(
                {},
                {
                    timeout: options.timeoutMs,
                    ...(options.signal === undefined ? {} : { signal: options.signal })
                }
            )
        );
    }

    /**
     * Invoke a tool upstream.
     *
     * NEVER retried. MCP provides no idempotency guarantee for tool calls, and
     * `annotations.idempotentHint` is server-supplied and therefore untrusted.
     * Retrying a timed-out write could double-execute a side effect.
     */
    async callTool(name: string, args: unknown, options: UpstreamRequestOptions): Promise<CallToolResult> {
        return this.guard('tools/call', () =>
            this.client.callTool(
                {
                    name,
                    ...(args === undefined ? {} : { arguments: args as Record<string, unknown> })
                },
                {
                    timeout: options.timeoutMs,
                    ...(options.signal === undefined ? {} : { signal: options.signal })
                }
            )
        );
    }

    async close(): Promise<void> {
        if (!this.connected) return;
        this.connected = false;
        try {
            await this.client.close();
        } catch (cause) {
            this.logger.warn('error closing upstream', { detail: cause instanceof Error ? cause.message : String(cause) });
        }
    }
}

/**
 * The set of upstream connections, keyed by operator-assigned server id.
 */
export class UpstreamPool {
    private readonly connections = new Map<string, UpstreamConnection>();
    private readonly logger: Logger;

    constructor(configs: readonly UpstreamServerConfig[], logger: Logger) {
        this.logger = logger;
        for (const config of configs) {
            this.connections.set(config.id, new UpstreamConnection(config, logger));
        }
    }

    get(serverId: string): UpstreamConnection | undefined {
        return this.connections.get(serverId);
    }

    all(): readonly UpstreamConnection[] {
        return [...this.connections.values()];
    }

    /**
     * Connect everything, tolerating individual failures.
     *
     * One unreachable upstream must not prevent the gateway from serving the
     * others (ARCHITECTURE.md NFR-R2). Returns the ids that failed.
     */
    async connectAll(): Promise<readonly string[]> {
        const failed: string[] = [];

        await Promise.all(
            this.all().map(async (connection) => {
                try {
                    await connection.connect();
                } catch (cause) {
                    failed.push(connection.config.id);
                    this.logger.error('upstream failed to connect', {
                        serverAlias: connection.alias,
                        detail: cause instanceof Error ? cause.message : String(cause)
                    });
                }
            })
        );

        return failed;
    }

    async closeAll(): Promise<void> {
        await Promise.all(this.all().map((connection) => connection.close()));
    }
}
