import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

/** Absolute path to the built stdio entry of the demo MCP server. */
export const DEMO_STDIO_ENTRY = resolve(repoRoot, 'servers/demo/basic-server/dist/stdio.js');

/** Absolute path to the built Streamable HTTP entry of the demo MCP server. */
export const DEMO_HTTP_ENTRY = resolve(repoRoot, 'servers/demo/basic-server/dist/http.js');

/** Tool names the demo server exposes, for assertions. */
export const DEMO_TOOL_NAMES = ['add', 'echo', 'fail_hard', 'fail_soft', 'get_constant', 'slow'] as const;
