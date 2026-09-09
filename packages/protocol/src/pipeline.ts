/**
 * The security pipeline seam.
 *
 * This interface is the boundary between the network layer and the decision
 * core. It exists in Phase 1 — before any enforcement is implemented — so that
 * the gateway is written against it from the first commit and never grows a
 * direct dependency from an HTTP handler onto security logic.
 *
 * Design constraints it encodes, all from ARCHITECTURE.md:
 *
 * - **§8.2 the decision core is pure.** Implementations receive plain data and
 *   return a decision. They are handed no transport, no request object and no
 *   database handle.
 * - **§9.4 no LLM in the enforcement path.** A decision is a value computed by
 *   deterministic code. Nothing in this interface can await a model.
 * - **§15 decisions are explainable.** A DENY carries a machine-readable reason
 *   and the rule that produced it, so "why was this denied?" always has an
 *   answer that can be reconstructed from an audit record.
 */

import type { RegisteredTool } from './types.js';

/** Everything the decision core is told about a `tools/call`. */
export interface ToolCallContext {
    readonly correlationId: string;
    readonly serverId: string;
    readonly serverAlias: string;
    /** The tool name as the upstream server knows it. */
    readonly upstreamName: string;
    /** The tool name as exposed downstream, e.g. `docs__search`. */
    readonly qualifiedName: string;
    /** Untrusted, caller-supplied arguments. */
    readonly args: unknown;
    readonly receivedAt: Date;
}

/** Everything the decision core is told about a `tools/list`. */
export interface ToolListContext {
    readonly correlationId: string;
    readonly receivedAt: Date;
}

/** The outcome of evaluating a request. Exactly one effect, always. */
export type Decision =
    | { readonly effect: 'ALLOW' }
    | {
          readonly effect: 'DENY';
          readonly code: number;
          readonly reason: string;
          /** Identifies what produced the decision, e.g. a policy rule name. */
          readonly source: string;
      };

export const ALLOW: Decision = { effect: 'ALLOW' };

/**
 * The contract every enforcement implementation satisfies.
 *
 * Phase 1 ships exactly one implementation: {@link passThroughPipeline}, which
 * enforces nothing. Later phases replace it without the gateway changing.
 */
export interface SecurityPipeline {
    /** A human-readable name, surfaced at startup so the active posture is visible. */
    readonly name: string;

    /** Whether this pipeline actually enforces anything. Logged loudly when false. */
    readonly enforcing: boolean;

    /** Decide whether a tool call may proceed. */
    evaluateToolCall(ctx: ToolCallContext): Promise<Decision>;

    /** Restrict the catalog exposed downstream. */
    filterToolList(ctx: ToolListContext, tools: readonly RegisteredTool[]): Promise<readonly RegisteredTool[]>;
}

/**
 * The Phase 1 pipeline: allows everything, filters nothing.
 *
 * This is not a placeholder that "will be secure later" — it is an explicit,
 * named, tested statement that Phase 1 provides NO enforcement, so that a
 * reader or reviewer cannot mistake a transparent proxy for a security control.
 * `enforcing: false` is asserted by a test and logged at startup.
 */
export const passThroughPipeline: SecurityPipeline = {
    name: 'pass-through',
    enforcing: false,

    evaluateToolCall(): Promise<Decision> {
        return Promise.resolve(ALLOW);
    },

    filterToolList(_ctx: ToolListContext, tools: readonly RegisteredTool[]): Promise<readonly RegisteredTool[]> {
        return Promise.resolve(tools);
    }
};
