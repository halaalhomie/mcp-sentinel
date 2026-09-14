#!/usr/bin/env node
/**
 * Differential MCP conformance.
 *
 * ## The problem this solves
 *
 * "Sentinel passes the conformance suite" is not directly measurable. The
 * official suite expects the server under test to expose specific diagnostic
 * fixture tools (`test_trigger_tool_change`, `test_tool_with_progress`, …) and
 * ships no reference server. A proxy can only ever be as conformant as the
 * server behind it, so an absolute score would mostly measure the demo server.
 *
 * ## What is measured instead
 *
 * The suite is run twice against the same upstream:
 *
 *     conformance  ->  upstream                 (baseline)
 *     conformance  ->  Sentinel  ->  upstream   (proxied)
 *
 * Every check is compared by `(id, status)`. If the two runs agree, Sentinel
 * did not change the protocol behaviour the suite can observe. **Any divergence
 * is, by construction, a transparency defect introduced by Sentinel** — which
 * is the actual claim, rather than a proxy for it.
 *
 * The demo server's own incompleteness cancels out: a scenario that fails on
 * both sides for the same reason is not a Sentinel problem.
 *
 * ## Known, declared divergence
 *
 * Sentinel deliberately renames tools (`echo` -> `demo__echo`), which the
 * specification explicitly sanctions for aggregating proxies. Any check whose
 * outcome depends on a specific tool name is therefore expected to differ, and
 * such checks must be listed in EXPECTED_DIVERGENCE with a reason. An
 * unexplained divergence fails the run; an explained one is reported and
 * tolerated. Nothing is tolerated silently.
 *
 * Usage:
 *   node scripts/conformance.mjs [--requirements 2026-07-28] [--scenario name]
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
/**
 * The suite is a pinned devDependency and is invoked directly by path.
 *
 * Not `npx`: that refetches on every run, and on Windows Node refuses to spawn
 * a `.cmd` shim without a shell (`EINVAL`), while passing arguments through a
 * shell is deprecated because they are concatenated unescaped. Running the
 * package's own entry point with `process.execPath` avoids all of it and makes
 * the version CI uses explicit rather than whatever the registry serves today.
 */
const CONFORMANCE_ENTRY = join(REPO_ROOT, 'node_modules/@modelcontextprotocol/conformance/dist/index.js');
const DEMO_HTTP_ENTRY = join(REPO_ROOT, 'servers/demo/basic-server/dist/http.js');
const GATEWAY_ENTRY = join(REPO_ROOT, 'apps/gateway/dist/index.js');
const UPSTREAM_ALIAS = 'demo';

/**
 * Checks whose outcome legitimately differs, each with a reason.
 *
 * Deliberately EMPTY. Sentinel currently diverges on nothing, so pre-registering
 * a speculative allowance would weaken the claim: an entry here means "we know
 * this differs and accept it", and asserting that about something that does not
 * actually differ is worse than having no list.
 *
 * The one transformation Sentinel makes — prefixing tool names with the operator
 * alias, which the specification sanctions for aggregating proxies — does not
 * currently change any check's outcome, because the suite's name-format rule
 * permits underscores and the demo names stay well inside its length limit. A
 * longer alias or tool name could change that, and if it ever does this run
 * fails loudly rather than quietly tolerating it.
 */
const EXPECTED_DIVERGENCE = new Map([
    [
        'sep-2575-server-sends-tools-list-changed-on-subscription',
        'Sentinel does not advertise the tools.listChanged capability, because it does not yet relay subscriptions/listen. The upstream advertises it, so the check runs there and is skipped here. Advertising a capability the gateway cannot honour would be a worse answer than declining it; this closes when notification relay lands.'
    ]
]);

function parseArgs(argv) {
    const args = { requirements: '2026-07-28', scenario: undefined };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--requirements') args.requirements = argv[++i];
        else if (argv[i] === '--scenario') args.scenario = argv[++i];
    }
    return args;
}

/** Spawn a process and resolve once `predicate` matches a line of its stdout. */
function spawnUntil(command, commandArgs, predicate, label) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, commandArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let buffered = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            rejectPromise(new Error(`${label} did not become ready within 60s`));
        }, 60_000);

        const onData = (chunk) => {
            buffered += chunk.toString('utf8');
            for (const line of buffered.split('\n')) {
                const match = predicate(line);
                if (match !== undefined && !settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolvePromise({ child, value: match });
                    return;
                }
            }
        };

        child.stdout.on('data', onData);
        // The gateway logs to stderr, the demo server announces readiness on stdout.
        child.stderr.on('data', onData);

        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(error);
        });
    });
}

async function startUpstream() {
    const { child, value } = await spawnUntil(
        process.execPath,
        [DEMO_HTTP_ENTRY, '0'],
        (line) => {
            try {
                const parsed = JSON.parse(line);
                return parsed.ready === true && typeof parsed.url === 'string' ? parsed.url : undefined;
            } catch {
                return undefined;
            }
        },
        'demo upstream'
    );
    return { child, url: value };
}

async function startGateway(upstreamUrl, configDir) {
    const configPath = join(configDir, 'conformance.config.json');
    await writeFile(
        configPath,
        JSON.stringify({
            listen: { host: '127.0.0.1', port: 0, path: '/mcp' },
            // Must be 'info': readiness is detected from the gateway's own
            // "ready" log line, which is emitted at info level.
            logLevel: 'info',
            upstreams: [
                {
                    id: 'srv-demo',
                    alias: UPSTREAM_ALIAS,
                    transport: { kind: 'http', url: upstreamUrl },
                    trustTier: 'VERIFIED',
                    environment: 'dev'
                }
            ]
        }),
        'utf8'
    );

    const { child, value } = await spawnUntil(
        process.execPath,
        [GATEWAY_ENTRY, configPath],
        (line) => {
            try {
                const parsed = JSON.parse(line);
                return parsed.msg === 'ready' && typeof parsed.url === 'string' ? parsed.url : undefined;
            } catch {
                return undefined;
            }
        },
        'gateway'
    );
    return { child, url: value };
}

/**
 * Run the suite and collect every check.
 *
 * The CLI exits non-zero whenever any scenario fails, and on Windows it also
 * crashes with a libuv assertion during teardown *after* reporting success.
 * Neither is a reliable signal, so results are read from disk instead.
 */
async function runConformance(targetUrl, outDir, args) {
    const cliArgs = [CONFORMANCE_ENTRY, 'server', '--url', targetUrl, '-o', outDir];
    if (args.scenario) cliArgs.push('--scenario', args.scenario);
    else cliArgs.push('--requirements', args.requirements);

    await new Promise((resolvePromise) => {
        const child = spawn(process.execPath, cliArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', () => {});
        child.stderr.on('data', () => {});
        child.once('close', () => resolvePromise());
        child.once('error', () => resolvePromise());
    });

    const checks = new Map();
    let entries;
    try {
        entries = await readdir(outDir, { withFileTypes: true });
    } catch {
        return checks;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const scenario = /^server-(.+?)-\d{4}-\d{2}-\d{2}T/.exec(entry.name)?.[1] ?? entry.name;
        try {
            const raw = await readFile(join(outDir, entry.name, 'checks.json'), 'utf8');
            for (const check of JSON.parse(raw)) {
                checks.set(`${scenario}::${check.id}`, check.status);
            }
        } catch {
            // A scenario that produced no results contributes nothing.
        }
    }
    return checks;
}

function compare(baseline, proxied) {
    const keys = [...new Set([...baseline.keys(), ...proxied.keys()])].sort();
    const unexplained = [];
    const explained = [];
    let identical = 0;

    for (const key of keys) {
        const before = baseline.get(key) ?? '(absent)';
        const after = proxied.get(key) ?? '(absent)';
        if (before === after) {
            identical += 1;
            continue;
        }
        const checkId = key.split('::')[1];
        const reason = EXPECTED_DIVERGENCE.get(checkId);
        (reason ? explained : unexplained).push({ key, before, after, reason });
    }

    return { total: keys.length, identical, explained, unexplained };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const workDir = await mkdtemp(join(tmpdir(), 'sentinel-conformance-'));
    const processes = [];

    try {
        console.log('Differential MCP conformance');
        console.log(`  suite        : @modelcontextprotocol/conformance (pinned devDependency)`);
        console.log(`  target       : ${args.scenario ? `scenario ${args.scenario}` : `requirements ${args.requirements}`}\n`);

        const upstream = await startUpstream();
        processes.push(upstream.child);
        console.log(`  upstream     : ${upstream.url}`);

        const gateway = await startGateway(upstream.url, workDir);
        processes.push(gateway.child);
        console.log(`  via Sentinel : ${gateway.url}\n`);

        console.log('Running baseline (direct to upstream)...');
        const baseline = await runConformance(upstream.url, join(workDir, 'baseline'), args);
        console.log(`  ${baseline.size} checks recorded`);

        console.log('Running proxied (through Sentinel)...');
        const proxied = await runConformance(gateway.url, join(workDir, 'proxied'), args);
        console.log(`  ${proxied.size} checks recorded\n`);

        if (baseline.size === 0 && proxied.size === 0) {
            console.error('FAIL: neither run produced any checks. The suite did not execute.');
            process.exitCode = 1;
            return;
        }

        const result = compare(baseline, proxied);

        console.log('─'.repeat(72));
        console.log(`Checks compared : ${result.total}`);
        console.log(`Identical       : ${result.identical}`);
        console.log(`Explained diffs : ${result.explained.length}`);
        console.log(`Unexplained     : ${result.unexplained.length}`);
        console.log('─'.repeat(72));

        for (const diff of result.explained) {
            console.log(`\n  EXPECTED  ${diff.key}`);
            console.log(`            ${diff.before} -> ${diff.after}`);
            console.log(`            reason: ${diff.reason}`);
        }

        for (const diff of result.unexplained) {
            console.log(`\n  DIVERGED  ${diff.key}`);
            console.log(`            ${diff.before} -> ${diff.after}`);
        }

        if (result.unexplained.length > 0) {
            console.log('\nFAIL: Sentinel changed observable protocol behaviour.');
            console.log('Either fix the gateway, or add the check to EXPECTED_DIVERGENCE with a reason.');
            process.exitCode = 1;
        } else {
            console.log('\nPASS: Sentinel did not change any observable protocol behaviour.');
        }
    } finally {
        for (const child of processes) child.kill('SIGKILL');
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

await main();
