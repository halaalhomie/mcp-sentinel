/**
 * Gateway configuration.
 *
 * Configuration is the operator's channel into Sentinel and is the ONLY source
 * of upstream identity. Nothing here may ever be derived from request data or
 * from what an upstream server reports about itself (ARCHITECTURE.md §8, T-4,
 * T-27).
 *
 * Validation is hand-written rather than schema-library-driven: the shape is
 * small, and an explicit parser makes the trust decisions legible.
 */

import { isValidAlias, type UpstreamServerConfig, type UpstreamTransportConfig } from '@mcp-sentinel/protocol';

export interface ListenConfig {
    readonly host: string;
    readonly port: number;
    readonly path: string;
}

export interface GatewayConfig {
    readonly listen: ListenConfig;
    readonly upstreams: readonly UpstreamServerConfig[];
    /**
     * Per-request upstream budget. On expiry the call is abandoned and reported
     * as UNKNOWN_OUTCOME — never retried, because MCP gives no idempotency
     * guarantee and `annotations.idempotentHint` is server-supplied and
     * therefore untrusted (ARCHITECTURE.md §11.2).
     */
    readonly upstreamRequestTimeoutMs: number;
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

function requireString(value: unknown, path: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new ConfigError(`${path} must be a non-empty string`);
    }
    return value;
}

function parseTransport(raw: unknown, path: string): UpstreamTransportConfig {
    if (typeof raw !== 'object' || raw === null) {
        throw new ConfigError(`${path} must be an object`);
    }
    const value = raw as Record<string, unknown>;
    const kind = requireString(value['kind'], `${path}.kind`);

    if (kind === 'stdio') {
        const args = value['args'];
        if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
            throw new ConfigError(`${path}.args must be an array of strings`);
        }
        const env = value['env'];
        if (env !== undefined && (typeof env !== 'object' || env === null)) {
            throw new ConfigError(`${path}.env must be an object`);
        }

        // `command` and `args` are kept separate and are never concatenated
        // into a shell string. There is no shell, so there is no shell
        // injection (ARCHITECTURE.md T-27).
        return {
            kind: 'stdio',
            command: requireString(value['command'], `${path}.command`),
            args: (args as string[] | undefined) ?? [],
            ...(env === undefined ? {} : { env: env as Record<string, string> }),
            ...(value['cwd'] === undefined ? {} : { cwd: requireString(value['cwd'], `${path}.cwd`) })
        };
    }

    if (kind === 'http') {
        const url = requireString(value['url'], `${path}.url`);
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new ConfigError(`${path}.url is not a valid URL`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new ConfigError(`${path}.url must use http or https`);
        }
        return { kind: 'http', url };
    }

    throw new ConfigError(`${path}.kind must be "stdio" or "http"`);
}

function parseUpstream(raw: unknown, index: number): UpstreamServerConfig {
    const path = `upstreams[${index}]`;
    if (typeof raw !== 'object' || raw === null) {
        throw new ConfigError(`${path} must be an object`);
    }
    const value = raw as Record<string, unknown>;

    const alias = requireString(value['alias'], `${path}.alias`);
    if (!isValidAlias(alias)) {
        throw new ConfigError(
            `${path}.alias "${alias}" is invalid: must match /^[a-z0-9][a-z0-9-]{0,31}$/. ` +
                'Underscores are excluded so that tool namespacing stays unambiguous.'
        );
    }

    const trustTier = requireString(value['trustTier'], `${path}.trustTier`);
    if (trustTier !== 'TRUSTED' && trustTier !== 'VERIFIED' && trustTier !== 'UNTRUSTED') {
        throw new ConfigError(`${path}.trustTier must be TRUSTED, VERIFIED or UNTRUSTED`);
    }

    const environment = requireString(value['environment'], `${path}.environment`);
    if (environment !== 'dev' && environment !== 'staging' && environment !== 'production') {
        throw new ConfigError(`${path}.environment must be dev, staging or production`);
    }

    return {
        id: requireString(value['id'], `${path}.id`),
        alias,
        transport: parseTransport(value['transport'], `${path}.transport`),
        trustTier,
        environment
    };
}

/** Parse and validate a configuration document. Throws ConfigError on any problem. */
export function parseConfig(raw: unknown): GatewayConfig {
    if (typeof raw !== 'object' || raw === null) {
        throw new ConfigError('configuration must be an object');
    }
    const value = raw as Record<string, unknown>;

    const listenRaw = (value['listen'] ?? {}) as Record<string, unknown>;
    const port = listenRaw['port'] ?? 8080;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new ConfigError('listen.port must be an integer between 0 and 65535');
    }

    const upstreamsRaw = value['upstreams'];
    if (!Array.isArray(upstreamsRaw)) {
        throw new ConfigError('upstreams must be an array');
    }
    const upstreams = upstreamsRaw.map(parseUpstream);

    // Aliases namespace every tool. A duplicate would make routing ambiguous,
    // so this fails at startup rather than producing a confusing catalog.
    const seenAliases = new Set<string>();
    const seenIds = new Set<string>();
    for (const upstream of upstreams) {
        if (seenAliases.has(upstream.alias)) {
            throw new ConfigError(`duplicate upstream alias "${upstream.alias}"`);
        }
        if (seenIds.has(upstream.id)) {
            throw new ConfigError(`duplicate upstream id "${upstream.id}"`);
        }
        seenAliases.add(upstream.alias);
        seenIds.add(upstream.id);
    }

    const timeout = value['upstreamRequestTimeoutMs'] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
        throw new ConfigError('upstreamRequestTimeoutMs must be a positive integer');
    }

    const logLevel = (value['logLevel'] ?? 'info') as string;
    if (logLevel !== 'debug' && logLevel !== 'info' && logLevel !== 'warn' && logLevel !== 'error') {
        throw new ConfigError('logLevel must be debug, info, warn or error');
    }

    return {
        listen: {
            host: typeof listenRaw['host'] === 'string' ? listenRaw['host'] : '127.0.0.1',
            port,
            path: typeof listenRaw['path'] === 'string' ? listenRaw['path'] : '/mcp'
        },
        upstreams,
        upstreamRequestTimeoutMs: timeout,
        logLevel
    };
}
