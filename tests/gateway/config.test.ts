import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_UPSTREAM_TIMEOUT_MS, parseConfig } from '../../apps/gateway/src/config.js';

const minimal = {
    upstreams: [
        {
            id: 'srv-docs',
            alias: 'docs',
            transport: { kind: 'stdio', command: 'node', args: ['server.js'] },
            trustTier: 'VERIFIED',
            environment: 'dev'
        }
    ]
};

describe('parseConfig', () => {
    it('parses a minimal configuration', () => {
        const config = parseConfig(minimal);
        expect(config.upstreams).toHaveLength(1);
        expect(config.upstreams[0]?.alias).toBe('docs');
    });

    it('applies safe defaults', () => {
        const config = parseConfig(minimal);
        // Binding to loopback by default matters: the MCP spec says servers
        // running locally SHOULD bind only to localhost.
        expect(config.listen.host).toBe('127.0.0.1');
        expect(config.listen.port).toBe(8080);
        expect(config.listen.path).toBe('/mcp');
        expect(config.upstreamRequestTimeoutMs).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
        expect(config.logLevel).toBe('info');
    });

    it('accepts an http upstream', () => {
        const config = parseConfig({
            upstreams: [{ ...minimal.upstreams[0], transport: { kind: 'http', url: 'http://127.0.0.1:9000/mcp' } }]
        });
        expect(config.upstreams[0]?.transport).toEqual({ kind: 'http', url: 'http://127.0.0.1:9000/mcp' });
    });
});

describe('rejects invalid configuration', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
        ['a non-object document', 'nope'],
        ['a missing upstreams array', {}],
        ['an upstream without an id', { upstreams: [{ ...minimal.upstreams[0], id: '' }] }],
        ['an unknown transport kind', { upstreams: [{ ...minimal.upstreams[0], transport: { kind: 'carrier-pigeon' } }] }],
        ['a stdio upstream without a command', { upstreams: [{ ...minimal.upstreams[0], transport: { kind: 'stdio' } }] }],
        ['stdio args that are not strings', { upstreams: [{ ...minimal.upstreams[0], transport: { kind: 'stdio', command: 'node', args: [1] } }] }],
        ['a non-http url scheme', { upstreams: [{ ...minimal.upstreams[0], transport: { kind: 'http', url: 'file:///etc/passwd' } }] }],
        ['a malformed url', { upstreams: [{ ...minimal.upstreams[0], transport: { kind: 'http', url: 'not a url' } }] }],
        ['an unknown trust tier', { upstreams: [{ ...minimal.upstreams[0], trustTier: 'PROBABLY_FINE' }] }],
        ['an unknown environment', { upstreams: [{ ...minimal.upstreams[0], environment: 'prod' }] }],
        ['a zero timeout', { ...minimal, upstreamRequestTimeoutMs: 0 }],
        ['a non-integer port', { ...minimal, listen: { port: 1.5 } }],
        ['an out-of-range port', { ...minimal, listen: { port: 70_000 } }],
        ['an unknown log level', { ...minimal, logLevel: 'verbose' }]
    ];

    it.each(cases)('rejects %s', (_label, document) => {
        expect(() => parseConfig(document)).toThrow(ConfigError);
    });
});

describe('security invariant: alias namespacing cannot be made ambiguous', () => {
    // The alias prefixes every tool name. If two upstreams shared an alias, one
    // qualified name would route to two servers.
    it('rejects duplicate aliases', () => {
        expect(() =>
            parseConfig({
                upstreams: [minimal.upstreams[0], { ...minimal.upstreams[0], id: 'srv-other' }]
            })
        ).toThrow(/duplicate upstream alias/);
    });

    it('rejects duplicate server ids', () => {
        expect(() =>
            parseConfig({
                upstreams: [minimal.upstreams[0], { ...minimal.upstreams[0], alias: 'other' }]
            })
        ).toThrow(/duplicate upstream id/);
    });

    it.each(['Docs', 'db_prod', '-lead', 'db.prod', 'a'.repeat(33), ''])('rejects the unusable alias %j', (alias) => {
        expect(() => parseConfig({ upstreams: [{ ...minimal.upstreams[0], alias }] })).toThrow(ConfigError);
    });
});

describe('security invariant: stdio invocation has no shell', () => {
    // A command and its arguments are kept as separate values and are never
    // concatenated into a string handed to a shell, so there is no shell
    // metacharacter interpretation to exploit (ARCHITECTURE.md T-27).
    it('keeps command and args separate', () => {
        const config = parseConfig({
            upstreams: [
                {
                    ...minimal.upstreams[0],
                    transport: { kind: 'stdio', command: 'node', args: ['server.js', '--flag', 'value with spaces; rm -rf /'] }
                }
            ]
        });

        const transport = config.upstreams[0]?.transport;
        expect(transport?.kind).toBe('stdio');
        if (transport?.kind !== 'stdio') return;

        expect(transport.command).toBe('node');
        expect(transport.args).toEqual(['server.js', '--flag', 'value with spaces; rm -rf /']);
        // The dangerous-looking argument stays a single opaque argv entry.
        expect(transport.args).toHaveLength(3);
    });

    it('defaults args to an empty array rather than undefined', () => {
        const config = parseConfig({
            upstreams: [{ ...minimal.upstreams[0], transport: { kind: 'stdio', command: 'node' } }]
        });
        const transport = config.upstreams[0]?.transport;
        if (transport?.kind !== 'stdio') throw new Error('expected stdio');
        expect(transport.args).toEqual([]);
    });
});
