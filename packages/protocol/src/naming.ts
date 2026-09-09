/**
 * Tool-name namespacing for an aggregating gateway.
 *
 * The MCP specification scopes tool-name uniqueness to a single server and
 * says that clients or proxies aggregating tools from multiple servers SHOULD
 * implement a disambiguation strategy such as prefixing with a server
 * identifier — and that a server's self-reported `serverInfo.name` is NOT
 * guaranteed unique and SHOULD NOT be used for it.
 *
 * Sentinel therefore namespaces with the *operator-assigned* alias.
 *
 * ## Why the alias charset excludes `_`
 *
 * The separator is `__`. If an alias could contain `_`, then `a__b__c` would be
 * ambiguous: it could be alias `a` + tool `b__c`, or alias `a__b` + tool `c`.
 * Restricting aliases to `[a-z0-9-]` makes the encoding *injective*: the first
 * `__` in a qualified name is always the separator, no matter what the tool
 * name contains. This is proven by a property test.
 *
 * ## Why resolution still goes through the registry
 *
 * Even though the encoding is injective, `resolveQualifiedName` is not used to
 * dispatch calls. The gateway resolves a downstream tool name by *exact lookup*
 * in the registry. Parsing a name supplied by an untrusted caller and trusting
 * the parts is how confused-deputy bugs happen; an exact lookup against a set
 * Sentinel built itself cannot invent a server or a tool that does not exist.
 * The parser exists for diagnostics and tests, not for routing.
 */

import { type Result, err, ok } from './types.js';

/** Separator between the operator alias and the upstream tool name. */
export const NAMESPACE_SEPARATOR = '__';

/**
 * Aliases are lowercase alphanumeric with hyphens, 1-32 chars, and must start
 * with an alphanumeric. Underscores are excluded — see the module docs.
 */
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Characters the MCP specification allows in a tool name: ASCII letters,
 * digits, underscore, hyphen and dot. Upstream names are untrusted input and
 * are validated against this before being recorded or re-exposed.
 */
export const UPSTREAM_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** Hard limit from the MCP specification's tool-name guidance. */
export const MAX_QUALIFIED_NAME_LENGTH = 128;

/**
 * Some MCP hosts constrain tool names more tightly than MCP itself does (a
 * 64-character, `[A-Za-z0-9_-]`-only pattern is common downstream of the
 * protocol). Exceeding this is not an error — it is a portability warning.
 */
export const CONSERVATIVE_QUALIFIED_NAME_LENGTH = 64;

export type NamingError =
    | { readonly kind: 'INVALID_ALIAS'; readonly alias: string }
    | { readonly kind: 'INVALID_TOOL_NAME'; readonly toolName: string }
    | { readonly kind: 'QUALIFIED_NAME_TOO_LONG'; readonly qualifiedName: string; readonly length: number };

/** Whether an operator-supplied alias is usable for namespacing. */
export function isValidAlias(alias: string): boolean {
    return ALIAS_PATTERN.test(alias);
}

/** Whether an upstream-supplied tool name is within the MCP-permitted charset. */
export function isValidUpstreamToolName(toolName: string): boolean {
    return UPSTREAM_TOOL_NAME_PATTERN.test(toolName);
}

/**
 * Build the name Sentinel exposes downstream for an upstream tool.
 *
 * Fails closed: a tool whose name Sentinel cannot represent unambiguously is
 * rejected rather than truncated. Truncation would risk two distinct upstream
 * tools collapsing onto one downstream name, which is a routing-confusion bug
 * with security consequences.
 */
export function qualifyToolName(alias: string, toolName: string): Result<string, NamingError> {
    if (!isValidAlias(alias)) {
        return err({ kind: 'INVALID_ALIAS', alias });
    }
    if (!isValidUpstreamToolName(toolName)) {
        return err({ kind: 'INVALID_TOOL_NAME', toolName });
    }

    const qualifiedName = `${alias}${NAMESPACE_SEPARATOR}${toolName}`;
    if (qualifiedName.length > MAX_QUALIFIED_NAME_LENGTH) {
        return err({ kind: 'QUALIFIED_NAME_TOO_LONG', qualifiedName, length: qualifiedName.length });
    }

    return ok(qualifiedName);
}

/**
 * Whether a qualified name may be rejected by strict downstream hosts.
 *
 * Advisory only — used to emit a startup warning, never to exclude a tool.
 */
export function hasPortabilityRisk(qualifiedName: string): boolean {
    return qualifiedName.length > CONSERVATIVE_QUALIFIED_NAME_LENGTH || qualifiedName.includes('.');
}

/**
 * Split a qualified name back into its parts.
 *
 * FOR DIAGNOSTICS AND TESTS ONLY. The gateway routes by exact registry lookup;
 * see the module documentation for why.
 */
export function resolveQualifiedName(qualifiedName: string): { alias: string; toolName: string } | undefined {
    const index = qualifiedName.indexOf(NAMESPACE_SEPARATOR);
    if (index <= 0) {
        return undefined;
    }

    const alias = qualifiedName.slice(0, index);
    const toolName = qualifiedName.slice(index + NAMESPACE_SEPARATOR.length);
    if (!isValidAlias(alias) || toolName.length === 0) {
        return undefined;
    }

    return { alias, toolName };
}
