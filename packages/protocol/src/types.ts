/**
 * Core domain types shared across Sentinel.
 *
 * These are deliberately plain data. Nothing in this package performs I/O, so
 * every type here can be constructed in a test without a network or database.
 */

/** Operator-assigned stable identity for an upstream MCP server. */
export type ServerId = string;

/**
 * How Sentinel reaches an upstream MCP server.
 *
 * `stdio` carries `command` plus a separate `args` array and never a shell
 * string: request data must never be able to influence process invocation
 * (ARCHITECTURE.md T-27).
 */
export type UpstreamTransportConfig =
    | {
          readonly kind: 'stdio';
          readonly command: string;
          readonly args: readonly string[];
          /** Extra environment on top of the SDK's safe-inherit default. */
          readonly env?: Readonly<Record<string, string>>;
          readonly cwd?: string;
      }
    | {
          readonly kind: 'http';
          readonly url: string;
      };

/**
 * An operator-declared upstream server.
 *
 * `alias` is the ONLY identity Sentinel trusts for namespacing. The MCP
 * specification states that a server's self-reported `serverInfo.name` is not
 * guaranteed unique and SHOULD NOT be relied upon for disambiguation, so it is
 * never used here.
 */
export interface UpstreamServerConfig {
    readonly id: ServerId;
    readonly alias: string;
    readonly transport: UpstreamTransportConfig;
    /**
     * Trust tier. Unused by Phase 1 enforcement (there is none), but carried
     * from the start so the registry shape does not change when the policy
     * engine lands.
     */
    readonly trustTier: 'TRUSTED' | 'VERIFIED' | 'UNTRUSTED';
    readonly environment: 'dev' | 'staging' | 'production';
}

/** A tool as Sentinel has recorded it, tied to the server that exposed it. */
export interface RegisteredTool {
    readonly serverId: ServerId;
    readonly serverAlias: string;
    /** The tool's name as the upstream server reports it. */
    readonly upstreamName: string;
    /** The name Sentinel exposes downstream, e.g. `docs__search`. */
    readonly qualifiedName: string;
    /**
     * The tool definition exactly as received from upstream.
     *
     * Treated as untrusted data: it is stored and forwarded, never interpreted
     * as a security assertion.
     */
    readonly definition: Readonly<Record<string, unknown>>;
}

/** Result type used where failure is expected and must be handled explicitly. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
