/**
 * Gateway bootstrap.
 *
 * Brings up the long-lived state in a deliberate order, warms the runtime, then
 * starts accepting traffic:
 *
 *   config -> upstream pool -> registry -> warm-up -> listener
 *
 * Startup is fail-fast. A misconfigured gateway refuses to start rather than
 * starting in a degraded state and denying every request at runtime, which is
 * the same fail-closed principle applied to boot.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { preloadSchemas as preloadClientSchemas } from '@modelcontextprotocol/client';
import { preloadSchemas as preloadServerSchemas } from '@modelcontextprotocol/server';
import { passThroughPipeline } from '@mcp-sentinel/protocol';

import { ConfigError, parseConfig, type GatewayConfig } from './config.js';
import { startGatewayHttpServer } from './http.js';
import { createLogger, type Logger } from './logging.js';
import { ToolRegistry } from './registry.js';
import { UpstreamPool } from './upstream.js';

const DEFAULT_CONFIG_PATH = 'sentinel.config.json';

async function loadConfig(path: string): Promise<GatewayConfig> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        throw new ConfigError(`could not read configuration file: ${path}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new ConfigError(`configuration file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    return parseConfig(parsed);
}

/**
 * Warm the SDK's lazily-compiled schema validators.
 *
 * Measured on 2026-09-10: the first request through a cold client cost roughly
 * four seconds, against 18-29ms in steady state. Without this, the first user
 * to call a tool after a deploy pays that penalty. The SDK notes that each
 * package bundles its own schema copy, so both the client and server copies are
 * warmed — Sentinel imports both.
 */
function warmSchemas(logger: Logger): void {
    const startedAt = Date.now();
    preloadClientSchemas();
    preloadServerSchemas();
    logger.info('schema validators warmed', { durationMs: Date.now() - startedAt });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const configPath = resolve(argv[0] ?? process.env['SENTINEL_CONFIG'] ?? DEFAULT_CONFIG_PATH);

    // A minimal logger until the configured level is known.
    let logger = createLogger('info', { service: 'mcp-sentinel' });

    const config = await loadConfig(configPath);
    logger = createLogger(config.logLevel, { service: 'mcp-sentinel' });

    logger.info('starting', {
        configPath,
        upstreams: config.upstreams.length,
        upstreamRequestTimeoutMs: config.upstreamRequestTimeoutMs
    });

    warmSchemas(logger);

    const pool = new UpstreamPool(config.upstreams, logger);
    const failed = await pool.connectAll();
    if (failed.length > 0) {
        // One unreachable upstream must not stop the gateway from serving the
        // others (ARCHITECTURE.md NFR-R2). It is loud, not fatal.
        logger.warn('some upstreams failed to connect', { failed, total: config.upstreams.length });
    }

    const registry = new ToolRegistry(logger);
    await registry.refresh(pool, config.upstreamRequestTimeoutMs);

    // Readiness means "can serve decisions", which requires at least one tool
    // to route to. A gateway with an empty catalog is alive but useless, and a
    // load balancer should know the difference.
    const isReady = (): boolean => registry.size > 0;

    const http = await startGatewayHttpServer(
        {
            listen: config.listen,
            deps: {
                registry,
                pool,
                pipeline: passThroughPipeline,
                logger,
                upstreamRequestTimeoutMs: config.upstreamRequestTimeoutMs
            },
            isReady
        },
        logger
    );

    logger.warn('gateway is NOT enforcing', {
        pipeline: passThroughPipeline.name,
        enforcing: passThroughPipeline.enforcing,
        // Stated at every startup on purpose. Phase 1 is a transparent proxy;
        // nobody should be able to run this and assume it is a security control.
        note: 'Phase 1 ships no enforcement. Every tool call is allowed.'
    });

    logger.info('ready', { url: `http://${config.listen.host}:${http.port}${config.listen.path}`, tools: registry.size });

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info('shutting down', { signal });

        void (async () => {
            try {
                await http.close();
                await pool.closeAll();
                logger.info('shutdown complete');
                process.exit(0);
            } catch (cause) {
                logger.error('error during shutdown', { detail: cause instanceof Error ? cause.message : String(cause) });
                process.exit(1);
            }
        })();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only run when executed directly, so tests can import `main` without starting
// a listener as a side effect of the import.
//
// `pathToFileURL` rather than string concatenation: on Windows a file URL is
// `file:///C:/...` with three slashes, so hand-building `file://${path}` never
// matches and the entry point silently does nothing. That is exactly what
// happened the first time this ran — the process exited 0 with no output.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'failed to start', detail: message })}\n`);
        process.exit(1);
    });
}
