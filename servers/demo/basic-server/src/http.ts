/**
 * Streamable HTTP entry point for the demo server.
 *
 * Exists so the gateway's *upstream HTTP* transport can be tested against a
 * real server, not a stub. Listens on 127.0.0.1 only.
 *
 * Usage: `node dist/http.js [port]` (0 = ephemeral; the chosen port is printed
 * to stdout as JSON so a test harness can read it).
 */

import { createServer, type IncomingMessage } from 'node:http';

import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createDemoServer } from './server.js';

const MCP_PATH = '/mcp';

const handler = createMcpHandler(() => createDemoServer(), {
    onerror: (error) => {
        process.stderr.write(`[demo-basic-server:http] ${error.message}\n`);
    }
});

const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

/**
 * Node types `IncomingMessage.method` and `.url` as `string | undefined`
 * (always present, possibly undefined), while the SDK's duck type declares
 * them as optional properties. Under `exactOptionalPropertyTypes` those are
 * not assignable even though the runtime shapes are identical. Narrow once
 * here rather than relaxing the compiler flag for the whole project.
 */
const asHandlerRequest = (req: IncomingMessage): Parameters<typeof nodeHandler>[0] =>
    req as unknown as Parameters<typeof nodeHandler>[0];

const server = createServer((req, res) => {
    // DNS-rebinding and Origin guards run before anything touches the body.
    // createMcpHandler is deliberately validation-free; the caller owns this.
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== MCP_PATH) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
    }

    void nodeHandler(asHandlerRequest(req), res);
});

const requestedPort = Number.parseInt(process.argv[2] ?? '0', 10);

server.listen(requestedPort, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
    // Machine-readable readiness line for the test harness.
    process.stdout.write(`${JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}${MCP_PATH}` })}\n`);
});

const shutdown = (): void => {
    server.close(() => {
        void handler.close().finally(() => process.exit(0));
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
