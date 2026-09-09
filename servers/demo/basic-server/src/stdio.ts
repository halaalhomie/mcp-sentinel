/**
 * stdio entry point for the demo server.
 *
 * Sentinel spawns this as a child process via StdioClientTransport. The SDK's
 * `serveStdio` owns the transport and serves both protocol eras from one
 * factory.
 *
 * Nothing may be written to stdout except protocol messages — stdout is the
 * wire. Diagnostics go to stderr.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createDemoServer } from './server.js';

const handle = serveStdio(() => createDemoServer(), {
    onerror: (error) => {
        process.stderr.write(`[demo-basic-server] ${error.message}\n`);
    }
});

const shutdown = (): void => {
    void Promise.resolve(handle.close()).finally(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
