/**
 * Error codes and client-facing error shaping.
 *
 * ## Code allocation
 *
 * The MCP specification partitions the JSON-RPC server-error range:
 *
 * - `-32000` to `-32019` — implementation-defined (legacy sub-range).
 * - `-32020` to `-32099` — **reserved exclusively for the MCP specification**.
 *   Implementations MUST NOT emit codes from this sub-range that the spec does
 *   not define, and MUST use defined ones only with their specified meanings.
 *
 * Sentinel therefore allocates its own codes in `-32000..-32019` and emits
 * `-32020` (HeaderMismatch), `-32021` (MissingRequiredClientCapability) and
 * `-32022` (UnsupportedProtocolVersion) only with their spec meanings.
 */

/** Standard JSON-RPC codes. */
export const JsonRpcErrorCode = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603
} as const;

/**
 * Sentinel's own codes, in the implementation-defined sub-range.
 *
 * Codes for later phases are reserved here deliberately so that the numbering
 * is stable and documented before anything emits them.
 */
export const SentinelErrorCode = {
    /** Sentinel could not reach the upstream server. */
    UPSTREAM_UNAVAILABLE: -32010,
    /** The upstream server did not respond within the configured budget. */
    UPSTREAM_TIMEOUT: -32011,
    /** The upstream server responded, but not in a way Sentinel could relay. */
    UPSTREAM_PROTOCOL_ERROR: -32012,

    // --- Reserved for later phases; nothing emits these yet. ---
    /** Phase 2: the tool is quarantined after security-relevant manifest drift. */
    TOOL_QUARANTINED: -32013,
    /** Phase 4: a deterministic policy rule denied the call. */
    POLICY_DENIED: -32014,
    /** Phase 5: the call needs human approval that does not yet exist. */
    APPROVAL_REQUIRED: -32015,
    /** Phase 5: an approval exists but does not bind this exact operation. */
    APPROVAL_INVALID: -32016
} as const;

export type SentinelErrorCodeValue = (typeof SentinelErrorCode)[keyof typeof SentinelErrorCode];

/** A JSON-RPC error payload as returned to a downstream caller. */
export interface ClientFacingError {
    readonly code: number;
    readonly message: string;
    readonly data: {
        readonly correlationId: string;
        readonly [key: string]: unknown;
    };
}

/**
 * An error Sentinel raises itself, carrying a message that is safe to return.
 *
 * The distinction matters: `publicMessage` is written by us for the caller;
 * arbitrary thrown errors are never surfaced verbatim (see `toClientFacingError`).
 */
export class SentinelError extends Error {
    readonly code: number;
    readonly publicMessage: string;
    readonly details: Readonly<Record<string, unknown>>;

    constructor(code: number, publicMessage: string, details: Readonly<Record<string, unknown>> = {}, options?: { cause?: unknown }) {
        super(publicMessage, options);
        this.name = 'SentinelError';
        this.code = code;
        this.publicMessage = publicMessage;
        this.details = details;
    }
}

/**
 * Convert any thrown value into an error safe to hand to a downstream caller.
 *
 * ARCHITECTURE.md §17.5: responses state the decision and a correlation ID and
 * MUST NOT leak upstream URLs or hostnames, stack traces, database errors, or
 * internal topology. An unrecognised throw is therefore reported as a generic
 * internal error — the real detail belongs in the logs, keyed by correlation ID.
 */
export function toClientFacingError(error: unknown, correlationId: string): ClientFacingError {
    if (error instanceof SentinelError) {
        return {
            code: error.code,
            message: error.publicMessage,
            data: { correlationId, ...error.details }
        };
    }

    return {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: 'Internal gateway error.',
        data: { correlationId }
    };
}

/**
 * Whether a code is inside the range the MCP specification reserves for itself.
 *
 * Used by a test that asserts Sentinel never allocates a code it is not allowed
 * to allocate.
 */
export function isSpecReservedErrorCode(code: number): boolean {
    return code <= -32020 && code >= -32099;
}
