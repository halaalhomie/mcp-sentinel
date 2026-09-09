import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            // Point workspace imports at TypeScript source rather than dist.
            //
            // Without this, a test importing SentinelError from the source tree
            // and gateway code importing it from the built package get two
            // distinct class objects, so `instanceof` silently fails. Aliasing
            // gives one identity and removes the need to build before testing.
            '@mcp-sentinel/protocol': resolve(import.meta.dirname, 'packages/protocol/src/index.ts')
        }
    },
    test: {
        include: ['tests/**/*.test.ts'],
        // Integration tests spawn real MCP servers over stdio and bind HTTP
        // ports; the default 5s timeout is tight for process startup on Windows.
        testTimeout: 30_000,
        hookTimeout: 60_000,
        // Each file gets its own process so a leaked child process or open
        // socket in one suite cannot affect another.
        pool: 'forks',
        reporters: process.env.CI ? ['default', 'junit'] : ['default'],
        outputFile: { junit: 'test-results/junit.xml' }
    }
});
