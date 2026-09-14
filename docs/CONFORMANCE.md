# MCP Conformance

**Last run:** checkpoint C9, 2026-09-15 · **Result:** 165 identical, 1 explained, **0 unexplained**

---

## What is being tested, and why not the obvious thing

The obvious claim would be *"Sentinel passes the official MCP conformance suite."* **That claim is
not directly measurable**, and this document explains what is measured instead.

The [official conformance suite](https://github.com/modelcontextprotocol/conformance) expects the
server under test to expose specific diagnostic fixture tools — `test_trigger_tool_change`,
`test_tool_with_progress`, `test_tool_with_logging` and others — and it **ships no reference
server**. This was verified by running it against the demo server: many scenarios fail simply
because a minimal server does not implement optional features.

Sentinel is a proxy. It can only ever be as conformant as the server behind it, so an absolute
score would mostly be measuring the demo server's completeness rather than Sentinel's transparency.

### Differential conformance

The suite is therefore run **twice against the same upstream**:

```
  conformance  ────────────────────────►  upstream        (baseline)

  conformance  ──►  Sentinel  ──────────►  upstream        (proxied)
```

Every check is compared by `(scenario, check id) → status`.

> **If the two runs agree, Sentinel did not change any protocol behaviour the suite can observe.
> Any divergence is, by construction, a defect introduced by Sentinel.**

This measures the actual claim — *Sentinel is protocol-transparent* — rather than a proxy for it.
It also makes the demo server's incompleteness cancel out: a scenario failing identically on both
sides is not a Sentinel problem.

---

## Running it

```bash
npm run build          # the harness runs the built gateway and demo server
npm run conformance    # full 2026-07-28 requirements suite, both sides
```

A single scenario, which is much faster while iterating:

```bash
node scripts/conformance.mjs --scenario tools-list
```

The harness starts a demo upstream on an ephemeral port, writes a temporary Sentinel config
pointing at it, starts the gateway on another ephemeral port, runs the suite against both, compares,
and cleans up. It exits non-zero on any unexplained divergence.

---

## Current result

```
Checks compared : 166
Identical       : 165
Explained diffs : 1
Unexplained     : 0

PASS: Sentinel did not change any observable protocol behaviour.
```

### The one declared divergence

| Check | Baseline | Proxied |
|---|---|---|
| `sep-2575-server-sends-tools-list-changed-on-subscription` | `WARNING` | `SKIPPED` |

Sentinel does not advertise the `tools.listChanged` capability, because it does not yet relay
`subscriptions/listen`. The upstream advertises it, so the check runs there and is skipped here.

Advertising a capability the gateway cannot honour would be a worse answer than declining it. This
closes when notification relay lands.

### Divergences are declared in code, not in prose

`scripts/conformance.mjs` holds an `EXPECTED_DIVERGENCE` map. An entry requires a written reason.
An **unexplained** divergence fails the run; an explained one is printed and tolerated. Nothing is
tolerated silently, and the list is deliberately kept as short as the truth allows — it was empty
until the run above produced a divergence with a real justification.

---

## What this caught

The harness found a genuine bug on its very first full run, which is the best argument for it.

**`sep-2575-http-server-method-not-found-404` — `SUCCESS` → `FAILURE`.**

The gateway had installed a `fallbackRequestHandler` to log unsupported methods and name the method
in the error. That looked harmless. It was not.

The SDK distinguishes two cases:

| Case | HTTP response |
|---|---|
| No handler registered for the method | `404 Not Found` + JSON-RPC `-32601` |
| A handler ran and threw | `200 OK` + JSON-RPC error |

The specification requires the first for a method the server does not implement. Installing a
fallback silently converted every unimplemented method into the second case. Sentinel was returning
`200` where the spec requires `404`.

The fallback was removed. It had never been needed for correctness — an unhandled method already
yields `-32601` on its own — so it was costing spec compliance to buy a log line.

**No amount of unit testing would have found this.** It only appears when you compare a proxy's
behaviour against the server it proxies.

---

## Limitations, stated plainly

| Limitation | Detail |
|---|---|
| **The suite is pre-1.0** | Pinned to `0.2.0-alpha.11`. The `--requirements` flag and the `2026-07-28` scenarios exist **only** in the `0.2.0` alpha line; the current `latest` (`0.1.16`) rejects the version outright with *"Unknown spec version: 2026-07-28"*. The CLI surface is still changing, so the version is pinned exactly rather than floated. |
| **Transparency is not security** | Conformance says Sentinel does not alter protocol behaviour. It says nothing about whether Sentinel's policy decisions are correct — there are none yet. |
| **Only what the suite observes** | Behaviour the suite does not exercise is not covered. The result is a floor, not a proof. |
| **One upstream, one transport** | The harness proxies a single Streamable HTTP upstream. Multi-upstream aggregation and stdio upstreams are covered by the integration suites, not here. |
| **Optional features are absent on both sides** | The demo server implements tools only. Scenarios for resources, prompts, tasks and MRTR fail identically on both sides and therefore contribute nothing either way. |
| **The CLI exits non-zero on success** | It exits `9` whenever any scenario fails, and on Windows also crashes with a libuv assertion during teardown *after* reporting results. The harness reads `checks.json` from disk and ignores the exit code. |

---

## In CI

`.github/workflows/ci.yml` runs the harness on every push and pull request, after the build and the
test suite. It is a **blocking** check: an unexplained divergence fails the build.

It was made blocking only once a green baseline existed, which is the sequence recommended in
[`SDK_RESEARCH.md` §7](./SDK_RESEARCH.md) — a gate that has never passed is not a gate.

---

## What would make this claim stronger

Honest future work rather than a to-do list:

1. **A conformance-fixture upstream.** A demo server implementing the suite's diagnostic tools would
   raise the absolute pass rate on both sides and exercise far more of the protocol through Sentinel.
2. **Multi-upstream differential runs.** Aggregation is where a proxy is most likely to diverge.
3. **Client-side conformance.** The suite can also test a *client*; Sentinel is one, to its
   upstreams, and that half is currently untested.
4. **Tracking the suite out of alpha.** The pin should move once `--requirements` reaches a stable
   release.
