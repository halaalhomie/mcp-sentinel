import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // Integration tests spawn real MCP servers over stdio and bind HTTP
        // ports; the default 5s timeout is tight for process startup on Windows.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // Each file gets its own process so a leaked child process or open
        // socket in one suite cannot affect another.
        pool: 'forks',
        reporters: process.env.CI ? ['default', 'junit'] : ['default'],
        outputFile: { junit: 'test-results/junit.xml' }
    }
});
