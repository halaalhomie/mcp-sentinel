import { spawn, type ChildProcess } from 'node:child_process';

import { DEMO_HTTP_ENTRY } from './demoServer.js';

export interface SpawnedHttpDemo {
    readonly url: string;
    readonly child: ChildProcess;
    kill(): void;
}

/**
 * Start the demo MCP server's Streamable HTTP entry point on an ephemeral port.
 *
 * Waits for the server's machine-readable readiness line on stdout rather than
 * sleeping a fixed interval, which is the usual source of flaky integration
 * tests. Port 0 lets suites run in parallel without colliding.
 */
export function spawnHttpDemo(): Promise<SpawnedHttpDemo> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [DEMO_HTTP_ENTRY, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });

        const timer = setTimeout(() => {
            child.kill();
            rejectPromise(new Error('demo http server did not become ready in time'));
        }, 30_000);

        let buffered = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            buffered += chunk.toString('utf8');
            const newline = buffered.indexOf('\n');
            if (newline === -1) return;

            const line = buffered.slice(0, newline);
            try {
                const parsed = JSON.parse(line) as { ready?: boolean; url?: string };
                if (parsed.ready === true && typeof parsed.url === 'string') {
                    clearTimeout(timer);
                    resolvePromise({
                        url: parsed.url,
                        child,
                        kill: () => child.kill('SIGKILL')
                    });
                }
            } catch {
                // Not the readiness line; keep reading.
            }
        });

        child.once('error', (error) => {
            clearTimeout(timer);
            rejectPromise(error);
        });
    });
}
