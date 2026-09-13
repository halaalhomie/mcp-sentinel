/**
 * The HTTP listener: Sentinel's downstream Streamable HTTP endpoint.
 *
 * ## Responsibility
 *
 * Terminate HTTP, apply the transport-level guards the MCP specification
 * requires, and hand conforming requests to a per-request MCP server instance.
 * It holds no protocol state of its own.
 *
 * ## Why the guards live here
 *
 * The SDK documents `createMcpHandler` as "deliberately validation-free" and
 * states that the caller must place Origin and Host validation in front of it.
 * Those guards defend against DNS rebinding: a page an attacker controls
 * resolves a hostname they own to a loopback address, then drives a
 * locally-bound MCP server from the victim's browser. The specification
 * requires servers to validate `Origin` and to bind to loopback when local.
 *
 * ## Operational endpoints
 *
 * `/healthz` answers whether the process is alive; `/readyz` answers whether it
 * can actually serve decisions. Keeping them distinct matters for a fail-closed
 * system: a gateway that is running but cannot reach its upstreams should be
 * taken out of a load balancer rather than left to refuse every call
 * (ARCHITECTURE.md NFR-R5).
 */

import { createServer, type IncomingMessage, type Server as NodeHttpServer } from 'node:http';

import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import type { ListenConfig } from './config.js';
import { createSentinelServer, type GatewayDeps } from './gateway.js';
import type { Logger } from './logging.js';

export interface GatewayHttpOptions {
    readonly listen: ListenConfig;
    readonly deps: GatewayDeps;
    /** Whether the gateway can currently serve. Drives `/readyz`. */
    readonly isReady: () => boolean;
}

export interface GatewayHttpServer {
    /** The port actually bound, which differs from the configured one when that was 0. */
    readonly port: number;
    close(): Promise<void>;
}

/**
 * Node types `IncomingMessage.method` and `.url` as `string | undefined`
 * (always present, possibly undefined) while the SDK's duck type declares them
 * as optional properties. Under `exactOptionalPropertyTypes` those are not
 * assignable even though the runtime shapes are identical. Narrowed once here
 * rather than relaxing the compiler flag for the whole project.
 */
type HandlerRequest = Parameters<ReturnType<typeof toNodeHandler>>[0];

const asHandlerRequest = (req: IncomingMessage): HandlerRequest => req as unknown as HandlerRequest;

export function startGatewayHttpServer(options: GatewayHttpOptions, logger: Logger): Promise<GatewayHttpServer> {
    const { listen, deps, isReady } = options;
    const httpLogger = logger.child({ component: 'http' });

    // One handler for the lifetime of the process. It calls the factory once
    // per request, which is what makes the 2026-07-28 stateless model work:
    // no session, no per-connection state, no sticky routing.
    const mcpHandler = createMcpHandler(() => createSentinelServer(deps), {
        onerror: (error) => httpLogger.error('mcp handler error', { detail: error.message })
    });

    const nodeHandler = toNodeHandler(mcpHandler, {
        onerror: (error) => httpLogger.error('node adapter error', { detail: error.message })
    });

    const validateHost = hostHeaderValidation([...listen.allowedHosts]);
    const validateOrigin = originValidation([...listen.allowedOrigins]);

    const server: NodeHttpServer = createServer((req, res) => {
        // Guards run before anything touches the body.
        if (!validateHost(req, res)) return;
        if (!validateOrigin(req, res)) return;

        const url = new URL(req.url ?? '/', 'http://localhost');

        if (url.pathname === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }

        if (url.pathname === '/readyz') {
            const ready = isReady();
            res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: ready ? 'ready' : 'not-ready' }));
            return;
        }

        if (url.pathname !== listen.path) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
            return;
        }

        void nodeHandler(asHandlerRequest(req), res);
    });

    return new Promise<GatewayHttpServer>((resolve, reject) => {
        server.once('error', reject);

        server.listen(listen.port, listen.host, () => {
            server.removeListener('error', reject);

            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : listen.port;

            httpLogger.info('listening', {
                host: listen.host,
                port,
                path: listen.path,
                allowedHosts: [...listen.allowedHosts],
                allowedOrigins: [...listen.allowedOrigins]
            });

            resolve({
                port,
                close: async () => {
                    await new Promise<void>((done) => server.close(() => done()));
                    await mcpHandler.close();
                    httpLogger.info('listener closed');
                }
            });
        });
    });
}
