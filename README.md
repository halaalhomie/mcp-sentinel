# MCP Sentinel

A zero-trust security and governance gateway for [Model Context Protocol](https://modelcontextprotocol.io) deployments.

Sentinel sits between an AI agent and the MCP servers it uses, so that every tool
invocation passes through a **deterministic, explainable, auditable** decision point that
the operator controls — not the model, and not the tool provider.

```
   AI Agent / MCP Host
            │
            │  MCP (Streamable HTTP)
            ▼
    ┌───────────────────┐
    │   MCP Sentinel    │   registry · risk · policy · approval · audit
    └─────────┬─────────┘
              │  MCP (stdio / Streamable HTTP)
      ┌───────┼───────┐
      ▼       ▼       ▼
   server  server  server
```

---

> ## ⚠️ Project status: early development
>
> **Phase 1 of 12 is partially complete. Sentinel currently enforces nothing.**
>
> What exists today is a partially-built transparent proxy with a well-defined seam where
> security will be inserted. The only `SecurityPipeline` implementation is
> `passThroughPipeline`, which declares `enforcing: false` and is tested to prove it allows
> everything.
>
> **Do not deploy this. It is not a security control yet.** See [Current status](#current-status).

---

## Why this exists

MCP lets an LLM agent discover and call tools exposed by external servers. Three properties
of that arrangement create a security problem:

1. **The decision-maker is manipulable.** The entity choosing which tool to call is a
   language model whose input includes attacker-influencable text — tool descriptions,
   prior tool results, file contents, issue bodies.
2. **Authority is coarse and durable; actions are fine-grained and instantaneous.** A user
   grants an agent access to a database server once. The agent may then issue `DROP TABLE`
   at 3am with no further human involvement.
3. **Approval is a point-in-time act against a mutable object.** A server reviewed and
   approved today can change its tool definitions tomorrow. This is the catalogued
   *rug pull* attack ([CVE-2025-54136](https://nvd.nist.gov/vuln/detail/CVE-2025-54136)).

The result is a gap between *what was authorized* and *what happens*, with no deterministic
control point in between and no durable record.

### Why not just put the controls in the MCP server?

Because you usually don't own it; because a malicious server won't enforce policy against
itself; because cross-server attacks (tool shadowing) are invisible from inside any single
server; and because N servers means N inconsistent implementations of policy and audit.

---

## What Sentinel does and does not claim

This distinction is the point of the project, and overclaiming here would make it
worthless. Full analysis in [`docs/ARCHITECTURE.md` §3.6](docs/ARCHITECTURE.md).

| Category | Meaning | Examples |
|---|---|---|
| **Control** | Deterministic. If it works, the outcome cannot occur. | Policy denial, manifest hash verification, approval binding, no-shell process spawning |
| **Detection** | Heuristic. Both false positives and false negatives expected. | Suspicious tool descriptions, credential patterns in results |
| **Out of scope** | Not addressed. | The agent being fooled; a malicious operator; network-level attacks |

**Sentinel does not solve prompt injection.** No system currently does. Sentinel changes
the model from *"hope the agent isn't fooled"* to *"assume it will be fooled, and constrain
what a fooled agent can accomplish."* That is mitigation of impact, not prevention of
injection.

### 🔴 A prerequisite Sentinel cannot enforce

**Upstream MCP servers must be reachable *only* through Sentinel.** If an agent can connect
to an upstream server directly, every control in this project is decorative. Network
isolation is a deployment responsibility and is outside Sentinel's power to guarantee.

---

## Current status

Updated at commit `53fe164`.

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Architecture, threat model, SDK research | ✅ Complete |
| 1 | Transparent MCP gateway | 🟡 **In progress** |
| 2 | Tool registry + manifest integrity | ⬜ Not started |
| 3 | Deterministic risk engine | ⬜ Not started |
| 4 | Policy engine | ⬜ Not started |
| 5 | Human approval workflow | ⬜ Not started |
| 6 | Audit + observability | ⬜ Not started |
| 7 | Dashboard | ⬜ Not started |
| 8 | Adversarial test suite | ⬜ Not started |
| 9 | Threat detections (advisory) | ⬜ Not started |
| 10 | Performance benchmarks | ⬜ Not started |
| 11 | Auth hardening | ⬜ Not started |
| 12 | Docs + release | ⬜ Not started |

### Phase 1 checkpoints

| ID | Deliverable | Status |
|---|---|---|
| C1 | Demo MCP server (stdio + Streamable HTTP) | ✅ |
| C2 | Gateway config parsing + structured logging | ✅ |
| C3 | Upstream stdio client | ✅ |
| C4 | Tool registry + namespaced `tools/list` | 🟡 In progress |
| C5 | `tools/call` relay | ⬜ |
| C6 | HTTP listener + bootstrap | ⬜ |
| C7 | End-to-end integration tests | ⬜ |
| C8 | Upstream HTTP transport | ⬜ |
| C9 | Conformance guide + CI | ⬜ |

### What works today

- Pure protocol layer: injective tool namespacing, error taxonomy, sanitised client-facing errors
- Operator configuration parsing with fail-fast validation
- Structured JSON logging with correlation IDs
- Upstream MCP client over **stdio**, with error translation and timeout handling
- A real demo MCP server used as an integration-test fixture
- **90 tests passing**

### What does not work yet

- ❌ There is no runnable gateway process (no HTTP listener, no `tools/list`, no `tools/call` relay)
- ❌ No enforcement of any kind
- ❌ No authentication of downstream callers
- ❌ No audit persistence
- ❌ Upstream HTTP transport is written but untested end-to-end
- ❌ Secret redaction in logs is *not* implemented (documented in `logging.ts`)

---

## Requirements

| | |
|---|---|
| Node.js | ≥ 22 (developed on 24) |
| npm | ≥ 10 (workspaces) |
| MCP protocol | `2026-07-28` |
| MCP SDK | `@modelcontextprotocol/*` v2.0.0 |

## Quick start

```bash
git clone https://github.com/halaalhomie/mcp-sentinel.git
cd mcp-sentinel
npm install
npm run build
npm test
```

Expected: **90 tests passing across 5 files.**

> There is no `npm start` yet — the gateway has no entry point until checkpoint C6.
> The integration tests spawn the demo MCP server as a real child process, so they are the
> current way to see the system actually speak MCP.

### Running the demo MCP server standalone

```bash
npm run build

# stdio (what the gateway spawns)
node servers/demo/basic-server/dist/stdio.js

# Streamable HTTP on an ephemeral port; prints its URL as JSON
node servers/demo/basic-server/dist/http.js 0
```

Inspect it with the official tooling:

```bash
npx @modelcontextprotocol/inspector
```

---

## Repository layout

```
mcp-sentinel/
├── docs/
│   ├── ARCHITECTURE.md     # specification, threat model, trust model (31 sections)
│   └── SDK_RESEARCH.md     # verified MCP SDK surface; resolves open decision OD-1
│
├── packages/
│   └── protocol/           # PURE. Zero dependencies. No I/O.
│       └── src/
│           ├── types.ts        # domain types
│           ├── naming.ts       # injective tool namespacing
│           ├── errors.ts       # error codes + client-facing sanitisation
│           └── pipeline.ts     # SecurityPipeline — the enforcement seam
│
├── apps/
│   └── gateway/            # the gateway process
│       └── src/
│           ├── config.ts       # operator configuration (only trusted identity source)
│           ├── logging.ts      # structured logging
│           └── upstream.ts     # upstream MCP client
│
├── servers/demo/
│   └── basic-server/       # a real MCP server used as a test fixture (never published)
│
└── tests/
    ├── protocol/           # 51 unit + property tests
    └── gateway/            # 39 unit + integration tests
```

### The dependency direction is the important part

```
  @mcp-sentinel/protocol      ← zero dependencies
            ▲
  @mcp-sentinel/gateway  →  @modelcontextprotocol/{client,server,node}
```

Nothing depends on the gateway. The `protocol` package depends on nothing. That is what
keeps the security decision core testable without a network, a database or a running server.

---

## Design principles

These are enforced by code and tests, not merely stated.

1. **No LLM in the enforcement path.** A model classifier would make enforcement
   non-deterministic, unexplainable, and itself injectable — reintroducing the exact
   vulnerability Sentinel exists to close. `SecurityPipeline` returns a value; nothing in
   its signature offers a place to await a model.
2. **The decision core is pure.** Risk, policy and canonicalisation perform no I/O, so any
   decision is reproducible offline from an audit record.
3. **Fail closed.** A policy enforcement point that fails open is not a policy enforcement
   point; it is a latency tax that provides false assurance. The one deliberate exception
   is read-only discovery.
4. **Server self-declarations are untrusted.** The MCP spec states clients **MUST** treat
   tool annotations as untrusted and **SHOULD NOT** use `serverInfo` for security decisions.
   Sentinel uses operator-assigned identity, and lets server hints only *escalate* risk,
   never lower it.
5. **Never rewrite what an upstream said.** The only field Sentinel modifies is the tool
   `name`, which the spec explicitly sanctions for aggregating proxies. Laundering a
   suspicious description would break the fingerprint contract and usually leaves a working
   injection anyway. The correct response is to remove the tool, not to edit it.
6. **Never retry a tool call.** MCP gives no idempotency guarantee, and
   `annotations.idempotentHint` is server-supplied. A retried write could double-execute.
7. **Document the gaps in the code.** Where a control is specified but not implemented, the
   source file says so.

---

## Testing

```bash
npm test              # all suites
npm run test:watch    # watch mode
```

| Suite | Tests | Kind |
|---|---|---|
| `protocol/naming` | 37 | Unit + property |
| `protocol/errors` | 10 | Unit + adversarial |
| `protocol/pipeline` | 4 | Unit |
| `gateway/config` | 27 | Unit + adversarial |
| `gateway/upstream` | 12 | Integration (real MCP server over stdio) |
| **Total** | **90** | |

Suites named `security invariant: …` assert a specific security property. They are meant to
be greppable and hard to delete casually.

Integration tests spawn the demo server as a genuine child process rather than mocking it.
That choice has already paid for itself: it revealed that a thrown upstream handler becomes
an in-band `isError` result rather than a JSON-RPC protocol error — the opposite of what the
code comments originally assumed.

### Conformance

The official [MCP conformance suite](https://github.com/modelcontextprotocol/conformance)
is not yet wired into CI (checkpoint C9). **No conformance claim is made until it passes.**

Two findings already recorded in [`docs/SDK_RESEARCH.md` §7](docs/SDK_RESEARCH.md):

- The `--requirements 2026-07-28` flag exists only in the `0.2.0-alpha` line; the `latest`
  release (`0.1.16`) rejects the version outright.
- The suite expects the server under test to expose specific fixture tools and ships no
  reference server — so conformance will be measured **differentially**: run the suite
  against an upstream directly, then against Sentinel proxying that upstream, and assert the
  results are identical. Any divergence is a transparency defect introduced by Sentinel.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The specification. Problem definition, threat model (STRIDE), trust boundaries, component architecture, request lifecycle, policy and risk design, manifest integrity, approval binding, audit model, failure matrix, testing strategy, roadmap, open decisions. |
| [`docs/SDK_RESEARCH.md`](docs/SDK_RESEARCH.md) | Verified MCP SDK API surface. Every signature read from shipped type declarations rather than recalled. Resolves open decision OD-1. |

---

## Acknowledgements

Built against the official [Model Context Protocol](https://modelcontextprotocol.io)
specification and TypeScript SDK. Threat model informed by published MCP security research
on tool poisoning, rug pulls and tool shadowing.

## License

Apache-2.0 (declared in `package.json`; a `LICENSE` file has not been added yet).
