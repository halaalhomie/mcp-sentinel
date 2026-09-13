/**
 * The tool registry.
 *
 * ## Responsibility
 *
 * Hold the authoritative mapping from a *downstream* qualified tool name to the
 * (upstream server, upstream tool name) pair that serves it, plus the tool
 * definition exactly as received.
 *
 * ## Why routing goes through here
 *
 * A downstream caller supplies a tool name. Sentinel resolves it by **exact
 * lookup in this map** — never by parsing the caller's string into parts and
 * trusting them. An exact lookup cannot address a server or tool that Sentinel
 * did not itself discover, which closes the class of confused-deputy bugs where
 * a crafted name reaches somewhere unintended.
 *
 * ## Trust boundary
 *
 * Everything ingested here came from an untrusted upstream (ARCHITECTURE.md §8
 * crossing ❸). Tool names are validated against the MCP charset before being
 * recorded; a tool that fails validation is EXCLUDED and logged, never
 * best-effort repaired. One malformed tool must not poison the catalog
 * (§11.1 failure table).
 *
 * ## Phase 1 scope
 *
 * Discovery happens once, at startup, into memory. There is no manifest
 * fingerprinting, no drift detection and no persistence — that is Phase 2.
 * Nothing here makes a security decision.
 */

import type { ListToolsResult } from '@modelcontextprotocol/server';
import { hasPortabilityRisk, isValidUpstreamToolName, qualifyToolName, type RegisteredTool } from '@mcp-sentinel/protocol';

import type { Logger } from './logging.js';
import type { UpstreamPool } from './upstream.js';

/** A single element of an MCP `tools/list` result, as the SDK types it. */
export type DownstreamTool = ListToolsResult['tools'][number];

export interface DiscoveryStats {
    readonly discovered: number;
    readonly excluded: number;
    readonly serversOk: number;
    readonly serversFailed: number;
}

export class ToolRegistry {
    /** qualified downstream name -> tool. The routing table. */
    private readonly byQualifiedName = new Map<string, RegisteredTool>();
    private readonly logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger.child({ component: 'registry' });
    }

    /**
     * Discover tools from every upstream and rebuild the routing table.
     */
    async refresh(pool: UpstreamPool, timeoutMs: number): Promise<DiscoveryStats> {
        const next = new Map<string, RegisteredTool>();
        let excluded = 0;
        let serversOk = 0;
        let serversFailed = 0;

        for (const connection of pool.all()) {
            const { config } = connection;
            let tools: readonly unknown[];

            try {
                const result = await connection.listTools({ timeoutMs });
                tools = result.tools ?? [];
                serversOk += 1;
            } catch (cause) {
                // An unreachable server contributes no tools. It must not
                // prevent other servers' tools from being served.
                serversFailed += 1;
                this.logger.error('tool discovery failed', {
                    serverAlias: config.alias,
                    detail: cause instanceof Error ? cause.message : String(cause)
                });
                continue;
            }

            for (const raw of tools) {
                const definition = raw as Record<string, unknown>;
                const upstreamName = definition['name'];

                if (typeof upstreamName !== 'string' || !isValidUpstreamToolName(upstreamName)) {
                    excluded += 1;
                    this.logger.warn('excluded tool with invalid name', {
                        serverAlias: config.alias,
                        // Logged as JSON so a hostile name cannot forge log structure.
                        rawName: JSON.stringify(upstreamName)
                    });
                    continue;
                }

                // The MCP specification requires `inputSchema` to be a valid
                // JSON Schema object and explicitly not null. A tool without
                // one cannot be represented downstream, so it is excluded
                // rather than repaired — a malformed tool must not be able to
                // take the whole catalog with it.
                const inputSchema = definition['inputSchema'];
                if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
                    excluded += 1;
                    this.logger.warn('excluded tool with missing or invalid inputSchema', {
                        serverAlias: config.alias,
                        upstreamName
                    });
                    continue;
                }

                const qualified = qualifyToolName(config.alias, upstreamName);
                if (!qualified.ok) {
                    excluded += 1;
                    this.logger.warn('excluded tool that cannot be namespaced', {
                        serverAlias: config.alias,
                        upstreamName,
                        reason: qualified.error.kind
                    });
                    continue;
                }

                if (next.has(qualified.value)) {
                    // Impossible while aliases are unique and qualification is
                    // injective, but asserted rather than assumed: a collision
                    // would mean one name routing to two servers.
                    excluded += 1;
                    this.logger.error('excluded tool due to qualified-name collision', {
                        serverAlias: config.alias,
                        qualifiedName: qualified.value
                    });
                    continue;
                }

                if (hasPortabilityRisk(qualified.value)) {
                    this.logger.warn('tool name may be rejected by strict hosts', {
                        qualifiedName: qualified.value,
                        length: qualified.value.length
                    });
                }

                next.set(qualified.value, {
                    serverId: config.id,
                    serverAlias: config.alias,
                    upstreamName,
                    qualifiedName: qualified.value,
                    definition
                });
            }
        }

        this.byQualifiedName.clear();
        for (const [name, tool] of next) {
            this.byQualifiedName.set(name, tool);
        }

        const stats: DiscoveryStats = {
            discovered: this.byQualifiedName.size,
            excluded,
            serversOk,
            serversFailed
        };
        this.logger.info('tool discovery complete', { ...stats });
        return stats;
    }

    /** Exact lookup. The only way a downstream name becomes a route. */
    resolve(qualifiedName: string): RegisteredTool | undefined {
        return this.byQualifiedName.get(qualifiedName);
    }

    /** All tools, in a deterministic order. */
    list(): readonly RegisteredTool[] {
        // The spec says servers SHOULD return tools in a deterministic order so
        // clients can cache and LLM prompt caches stay warm.
        return [...this.byQualifiedName.values()].sort((a, b) => (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0));
    }

    get size(): number {
        return this.byQualifiedName.size;
    }
}

/**
 * Project a registered tool into the definition exposed downstream.
 *
 * The ONLY field Sentinel rewrites is `name`, which the specification
 * explicitly sanctions for aggregating proxies. Descriptions, schemas and
 * annotations are passed through byte-for-byte.
 *
 * ARCHITECTURE.md §11.1 records why descriptions are never rewritten even when
 * they look hostile: it would break the fingerprint contract, partial
 * sanitization of an injection usually leaves a working injection, and it makes
 * the gateway a semantic actor rather than a policy enforcer. The correct
 * response to an intolerable description is to remove the tool (Phase 2), not
 * to launder it.
 *
 * ## On the assertion
 *
 * The registry stores `definition` as an opaque bag precisely because it is
 * untrusted upstream data, while the SDK's `ListToolsResult` demands a
 * structured `Tool`. The gap is bridged by `refresh()`, which admits a tool
 * only after proving that `name` is a string in the MCP charset and that
 * `inputSchema` is a non-null, non-array object — the two fields the target
 * type requires. The assertion therefore restates a checked invariant rather
 * than assuming an unchecked one.
 */
export function toDownstreamTool(tool: RegisteredTool): DownstreamTool {
    return { ...tool.definition, name: tool.qualifiedName } as unknown as DownstreamTool;
}
