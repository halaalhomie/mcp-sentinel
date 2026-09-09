# MCP SDK & Specification Research

**Date:** 2026-09-10
**Purpose:** Resolve Open Decision **OD-1** from [`ARCHITECTURE.md`](./ARCHITECTURE.md) — *does the
official TypeScript SDK provide a Gateway/Proxy abstraction suitable for MCP Sentinel?* — and
establish the verified API surface Phase 1 will be built on.

**Method:** `@modelcontextprotocol/{client,server,node}@2.0.0` were installed into a
throwaway scratchpad directory (deliberately **not** the repository, since the repo layout
was still an open decision) and their shipped `.d.mts` type declarations were read
directly. The conformance CLI was executed to observe its real behaviour.

> **Every API signature in this document was copied from a shipped type declaration or
> observed CLI output. Nothing here is recalled from memory or inferred.** Anything not
> directly verified is marked **[UNVERIFIED]**.

---

## 1. Headline answers

| Question | Answer |
|---|---|
| **Does the SDK provide a `Gateway` abstraction?** | **No.** No `Gateway` class, function, or interface is exported. |
| **Then what were the docs referring to?** | A **documentation guide**, `docs/advanced/gateway.md`, which lives in the SDK's source repository and is *not* shipped in the npm package. The three occurrences of "gateway" in the shipped types are prose cross-references to it. |
| **Can we still build Sentinel on the SDK?** | **Yes, comfortably.** The SDK exports the individual primitives a gateway needs — including one (`fallbackRequestHandler`) that is precisely a transparent-relay hook. |
| **Do we need a hand-rolled proxy?** | **No.** Building a bespoke JSON-RPC/Streamable-HTTP implementation would be a conformance liability for no gain. |
| **Does this invalidate the architecture?** | **No.** One discrepancy was found, and it is in the *conformance tooling*, not the SDK — see §7. |

---

## 2. Current protocol and package versions

### 2.1 Protocol

| Item | Value |
|---|---|
| Current protocol revision | **`2026-07-28`** |
| Previous stable revision | `2025-11-25` |
| Negotiation | Per-request, via `_meta["io.modelcontextprotocol/protocolVersion"]` + the `MCP-Protocol-Version` HTTP header (the two must match) |
| Sessions | **Removed.** No `initialize` handshake, no `Mcp-Session-Id` |

### 2.2 Packages (verified against the npm registry, 2026-09-10)

| Package | Version | Role |
|---|---|---|
| `@modelcontextprotocol/sdk` | `1.30.0` | **v1 line — do not use.** Pre-dates the stateless revision. |
| `@modelcontextprotocol/server` | **`2.0.0`** | Server/handler primitives |
| `@modelcontextprotocol/client` | **`2.0.0`** | Upstream client + transports |
| `@modelcontextprotocol/node` | **`2.0.0`** | Node adapters (`toNodeHandler`, host/origin guards) |
| `@modelcontextprotocol/core` | `2.0.0` | Transitive dependency of the above |
| `@modelcontextprotocol/conformance` | `0.1.16` (latest) / `0.2.0-alpha.11` (alpha) | Conformance CLI — **see §7** |

The v2 line ships under **new package names**; installing them is itself the opt-in to the
`2026-07-28` era. Each package exposes the subpaths `.`, `./stdio`, `./validators/ajv`,
`./validators/cf-worker`, and `./_shims`.

---

## 3. Server-side API (what Sentinel exposes downstream)

### 3.1 The HTTP entry point

```ts
declare function createMcpHandler(
    factory: McpServerFactory,
    options?: CreateMcpHandlerOptions
): McpHttpHandler;
```

```ts
interface McpHttpHandler {
    /** Web-standard face: serve one HTTP request and resolve with the response. */
    fetch: (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>;
    close: () => Promise<void>;
    notify: ServerNotifier;   // publish-side facade over the subscriptions/listen bus
    bus: ServerEventBus;      // the change-event bus listen streams subscribe to
}
```

```ts
type McpServerFactory =
    (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

interface McpRequestContext {
    era: 'legacy' | 'modern';
    authInfo?: AuthInfo;    // strictly pass-through; never derived from headers
    requestInfo?: Request;  // the original HTTP request (HTTP only)
}

interface McpHandlerRequestOptions {
    authInfo?: AuthInfo;
    parsedBody?: unknown;   // e.g. req.body from express.json()
}
```

**The factory is invoked per HTTP request.** This is the stateless model expressed in the
API: there is no long-lived server object holding connection state. This aligns exactly
with `ARCHITECTURE.md` §6.3 NFR-SC1 (stateless request handling, no sticky routing).

### 3.2 Options

```ts
interface CreateMcpHandlerOptions {
    legacy?: 'stateless' | 'reject';
    onerror?: (error: Error) => void;
    // (further response-shaping options omitted here)
}
```

- `'stateless'` (default) — 2025-era traffic is served per-request from the same factory;
  `GET`/`DELETE` are answered `405`.
- `'reject'` — modern-only strict; legacy requests get the unsupported-protocol-version
  error.

### 3.3 Security responsibilities the SDK explicitly does **not** take

Quoted from the `createMcpHandler` declaration comment:

> "When mounting bare on a fetch-native runtime, put Origin/Host validation in front of the
> handler — **the entry itself is deliberately validation-free**"

> "The entry performs no token verification: `authInfo` given to `fetch` is passed through
> to handlers and the factory as-is and is **never derived from request headers**."

> "such compositions must reject POSTs whose Content-Type media type is not
> `application/json` (415) before parsing the body, using `isJsonContentType`; neither
> building block performs this validation itself."

**This is important and pleasant:** the SDK's security posture matches Sentinel's. It
refuses to guess at authentication and makes the caller own it. Sentinel supplies
`authInfo` from its own authenticator, and the SDK carries it through untouched.

Guards the SDK *does* provide:

```ts
// @modelcontextprotocol/server (web-standard)
validateOriginHeader / originValidationResponse / localhostAllowedOrigins
validateHostHeader   / hostHeaderValidationResponse / localhostAllowedHostnames
isJsonContentType

// @modelcontextprotocol/node (node:http / Express style)
declare function hostHeaderValidation(allowedHostnames: string[]):
    (req: IncomingMessage, res: ServerResponse) => boolean;
declare function originValidation(allowedOriginHostnames: string[]):
    (req: IncomingMessage, res: ServerResponse) => boolean;
declare function localhostHostValidation(): ...
declare function localhostOriginValidation(): ...
```

### 3.4 Node adapter

```ts
declare function toNodeHandler(
    handler: FetchLikeMcpHandler,
    opts?: ToNodeHandlerOptions
): NodeMcpRequestHandler;
```

Converts a Node request to a web `Request`, calls `handler.fetch`, and writes the
`Response` back — "honoring write backpressure for streamed SSE responses." `req.auth` is
forwarded as the pass-through `authInfo`.

This satisfies `ARCHITECTURE.md` §10.1's requirement to relay SSE without buffering,
**using SDK code rather than ours.**

### 3.5 High-level vs low-level server

```ts
declare class McpServer {
    readonly server: Server;
    constructor(serverInfo: Implementation, options?: ServerOptions);
    connect(transport: Transport): Promise<void>;
    registerTool<InputArgs extends ZodRawShape, OutputArgs ...>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            icons?: Icon[];
            _meta?: Record<string, unknown>;
        },
        cb: LegacyToolCallback<InputArgs>
    ): RegisteredTool;
    // registerResource, registerPrompt, …
}

declare class Server extends Protocol<ServerContext> { … }
```

`McpServer` is the ergonomic face for **authoring** a server (our demo servers).
`Server` is the low-level `Protocol` subclass — relevant for the gateway, see §5.

### 3.6 stdio serving

`@modelcontextprotocol/server/stdio` exports `serveStdio` with:

```ts
interface ServeStdioOptions {
    legacy?: 'serve' | 'reject';
    transport?: Transport;          // defaults to StdioServerTransport over process stdio
    onerror?: (error: Error) => void;
    maxSubscriptions?: number;      // default 1024
}
```

Used by the demo servers, not by Sentinel's downstream face (see OD-6: downstream is
Streamable HTTP only for MVP).

---

## 4. Client-side API (what Sentinel uses upstream)

```ts
declare class Client extends Protocol<ClientContext> {
    connect(transport: Transport, options?: ConnectOptions): Promise<void>;
    close(): Promise<void>;

    discover(options?: RequestOptions): Promise<DiscoverResult>;

    listTools(params?: ListToolsRequest['params'],
              options?: CacheableRequestOptions): Promise<ListToolsResult>;
    callTool(params: CallToolRequest['params'],
             options?: CallToolRequestOptions): Promise<CallToolResult>;

    listResources(params?, options?: CacheableRequestOptions): Promise<ListResourcesResult>;
    readResource(params, options?: CacheableRequestOptions): Promise<ReadResourceResult>;
    listPrompts(params?, options?: CacheableRequestOptions): Promise<ListPromptsResult>;
    getPrompt(params, options?: RequestOptions): Promise<GetPromptResult>;
}
```

### 4.1 Version negotiation

```ts
type VersionNegotiationMode = 'legacy' | 'auto' | { pin: string };

interface VersionNegotiationOptions {
    mode?: VersionNegotiationMode;   // @default 'legacy'
    probe?: VersionNegotiationProbeOptions;
}
```

**Note the default is `'legacy'`.** A `Client` constructed without
`versionNegotiation` will *not* speak `2026-07-28`. Sentinel must set this explicitly —
`{ mode: 'auto' }` for general upstreams, or `{ mode: { pin: '2026-07-28' } }` for
known-modern ones.

`ConnectOptions` also accepts a cached `prior` discovery result:

```ts
type PriorDiscovery =
    | { kind: 'modern'; discover: DiscoverResult }   // zero round trips
    | { kind: 'legacy' };
```

The declaration carries an explicit warning worth recording: *"a stale modern verdict
fails loudly at the first request, but a stale legacy verdict succeeds silently forever
(an upgraded server still answers `initialize`) — date cached legacy verdicts in your own
storage and stop supplying them past your policy horizon."*

**[DECISION for Phase 2+]** If Sentinel ever persists discovery verdicts, legacy verdicts
must carry a timestamp and an expiry. Not needed in Phase 1.

### 4.2 Transports

```ts
// @modelcontextprotocol/client
declare class StreamableHTTPClientTransport implements Transport {
    constructor(url: URL, opts?: StreamableHTTPClientTransportOptions);
}

// @modelcontextprotocol/client/stdio
type StdioServerParameters = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: IOType | Stream | number;   // default "inherit"
    cwd?: string;
    maxBufferSize?: number;              // default 10 MB
};

declare class StdioClientTransport implements Transport {
    constructor(server: StdioServerParameters);
    start(): Promise<void>;
    close(): Promise<void>;
    get stderr(): Stream | null;
    get pid(): number | null;
}

declare function getDefaultEnvironment(): Record<string, string>;
declare const DEFAULT_INHERITED_ENV_VARS: string[];
```

Two things matter for Sentinel's threat model:

1. `StdioServerParameters` takes `command` **plus a separate `args` array** — no shell
   string. This directly supports `ARCHITECTURE.md` T-27 (no shell interpolation; argv
   arrays only).
2. `getDefaultEnvironment()` returns "only environment variables deemed safe to inherit,"
   and `maxBufferSize` bounds a single message at 10 MB by default. Both are useful
   defaults for treating upstream servers as untrusted.

---

## 5. The transparent-relay primitive

This is the most important finding for Phase 1. `Protocol` (base class of both `Server` and
`Client`) exposes:

```ts
/** A handler to invoke for any request types that do not have their own handler installed. */
fallbackRequestHandler?: (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

/** A handler to invoke for any notification types that do not have their own handler installed. */
fallbackNotificationHandler?: (notification: Notification) => Promise<void>;
```

and, for sending:

```ts
// Spec methods: result schema resolved automatically from the method name
request<M extends RequestMethod>(
    request: { method: M; params?: Record<string, unknown> },
    options?: RequestOptions
): Promise<ResultTypeMap[M]>;

// Custom / unknown methods: an explicit result schema is REQUIRED
request<T extends StandardSchemaV1>(
    request: Request,
    resultSchema: T,
    options?: RequestOptions
): Promise<StandardSchemaV1.InferOutput<T>>;
```

Also available:

```ts
setRequestHandler<M extends RequestMethod>(
    method: M,
    handler: (request: RequestTypeMap[M], ctx: ContextT) =>
        HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>
): void;

setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined>(
    method: string,
    schemas: { params: P; result?: R },
    handler: …
): void;
```

### 5.1 The relay trap

The two-overload design of `request()` contains a subtle hazard the SDK documents: for a
**spec method**, calling without a result schema causes the SDK to enforce **the spec's own
result schema**. A relay that blindly forwards a method it does not understand can
therefore have a valid upstream response rejected by its own client-side validation.

**[DECISION D-1]** Sentinel's relay path forwards **known spec methods** via the
method-keyed overload (so we get correct validation for free), and any **unknown method**
via the explicit-schema overload with a permissive pass-through schema. Unknown methods are
relayed opaquely, never schema-coerced.

### 5.2 The Phase 1 architecture that follows

```
downstream HTTP  ──►  toNodeHandler( createMcpHandler(factory) )
                                          │
                     factory(ctx) ──► new Server(...)  (fresh per request)
                                          │
                          setRequestHandler('tools/list',  …)
                          setRequestHandler('tools/call',  …)
                          fallbackRequestHandler = opaque relay
                                          │
                                          ▼
                              UpstreamPool.get(serverId)
                                          │
                          Client + StdioClientTransport
                                  or StreamableHTTPClientTransport
                                          │
                                          ▼
                                 upstream MCP server
```

This maps cleanly onto `ARCHITECTURE.md` §9.2 and §10, with the SDK supplying the
transport, framing, validation, and SSE relay, and Sentinel supplying registry lookup,
namespacing, and (in later phases) the decision core.

---

## 6. Capabilities that reduce planned work

Four SDK features overlap with components the architecture had specified as ours to build.

| Architecture item | SDK provides | Verdict |
|---|---|---|
| §10.5 principal-partitioned registry cache (FR-14) | `ResponseCacheStore`, `InMemoryResponseCacheStore`, `CacheScope`, `CacheMode`, `MAX_CACHE_TTL_MS` | **Reuse.** See §6.1. |
| §10.4 ordered inbound validation | `classifyInboundRequest`, `InboundValidationRung`, `InboundLadderRejection`, `InboundModernRoute`, `InboundLegacyRoute` | Reuse for protocol shape; **still add our own header/body equality check** (§6.2) |
| §17.2 RFC 9728 / 8707 / 9207 machinery | `buildOAuthProtectedResourceMetadata`, `getOAuthProtectedResourceMetadataUrl`, `requireBearerAuth`, `verifyBearerToken`, `bearerAuthChallengeResponse`, `selectResourceURL`, `checkResourceAllowed`, `computeScopeUnion`, `isStrictScopeSuperset`, `validateAuthorizationResponseIssuer` | Available; **not Phase 1** |
| §17.3 P2 token exchange | `CrossAppAccessProvider`, `discoverAndRequestJwtAuthGrant`, `exchangeJwtAuthGrant`, `IdJagTokenExchangeResponse` | Available; **not Phase 1** |

### 6.1 Convergent design — worth recording

The SDK's response cache partitions entries by a JSON-encoded `[serverIdentity, principal]`
pair. Its declaration states the reason:

> "`partition` namespaces the entry by connected-server identity AND per-principal scope:
> the `Client` writes a JSON-encoded `[serverIdentity, principal]` pair (**so a
> server-controlled `serverInfo` string cannot bleed into the principal slot** regardless
> of what characters it contains). A `'public'`-scoped entry lives at
> `[serverIdentity, '']`; a `'private'`-scoped entry at `[serverIdentity, cachePartition]`."

This is the same cross-tenant-disclosure defense `ARCHITECTURE.md` §10.5 specified
independently. Reuse the SDK's implementation rather than writing our own.

### 6.2 What the SDK does *not* do for us

The SDK performs SEP-2243 `Mcp-Param-*` validation pre-dispatch (confirmed by the internal
`toolInputSchemaJson` comment on `McpServer`). That is **protocol shape** validation.

It does **not** relieve Sentinel of:

- header/body equality as an *anti-policy-evasion* control (`ARCHITECTURE.md` T-12) — the
  SDK validates what the spec requires of a server; Sentinel additionally refuses to make
  any decision from a header value;
- audience-bound token validation (the handler explicitly does no token verification);
- treating upstream tool metadata as untrusted;
- everything in the decision core.

**The SDK gives conformance. It does not give Sentinel's threat model.**

---

## 7. Discrepancy found — conformance tooling

> Reported rather than silently corrected, per the project's standing instruction.

`ARCHITECTURE.md` §23.4 and §25.2 specify running:

```bash
npx @modelcontextprotocol/conformance server --url http://localhost:8080/mcp \
    --requirements 2026-07-28
```

**That command does not work on the current `latest` release.** Observed directly:

| Version | `--requirements` flag | Knows `2026-07-28`? |
|---|---|---|
| `0.1.16` (**`latest`**) | **Absent** | **No** — `Unknown spec version: 2026-07-28`. Valid versions: `2025-03-26, 2025-06-18, 2025-11-25, draft, extension` |
| `0.2.0-alpha.11` (`alpha`) | **Present** | **Yes** — 40 server scenarios and 35 client scenarios tagged `2026-07-28` |

The `--requirements <revision>` flag ("Run exactly the scenarios a spec revision requires,
frozen at its release") and the `draft` suite exist **only in the 0.2.0 alpha line**.

### Impact

Low, but it must be stated honestly rather than glossed:

- To test against `2026-07-28` at all, we must pin the **alpha** conformance release.
- The conformance suite is **pre-1.0** and its CLI surface is still changing between
  `0.1.x` and `0.2.0`. Pin an exact version in CI; do not float.
- `ARCHITECTURE.md` §23.4's claim that the suite is a stable build gate is **premature**.
  It is a build gate against a moving, pre-release target.

### Recommendation

1. Pin `@modelcontextprotocol/conformance@0.2.0-alpha.11` exactly.
2. Treat conformance failures as **informational in CI until Phase 1 has a green baseline**,
   then promote to blocking — and record the promotion in the commit history.
3. Document the pre-1.0 caveat prominently in `docs/CONFORMANCE.md`.
4. **Do not claim conformance anywhere until it demonstrably passes.**

No change to Sentinel's design follows from this. It is a tooling-maturity caveat.

---

## 8. Limitations of this research

| Limitation | Effect |
|---|---|
| `docs/advanced/gateway.md` was not read — it is not shipped in the npm package | There may be an officially recommended relay recipe we have not seen. Worth fetching from the SDK source repository before Phase 2. **[UNVERIFIED]** |
| Response-shaping options on `CreateMcpHandlerOptions` were only partially read | The `'auto'` JSON-vs-SSE upgrade behaviour is understood in outline only |
| `subscriptions/listen` relay through `ServerEventBus` / `ServerNotifier` was not prototyped | Phase 1 covers `tools/list` and `tools/call`; notification relay is deferred |
| No runtime behaviour was exercised in this pass — declarations only | Everything here is compile-time truth; runtime truth comes from the Phase 1 tests |
| MRTR (`InputRequiredResult`) relay not designed | Tracked as `ARCHITECTURE.md` OD-5 |

---

## 9. Recommendation

**Build Sentinel's gateway on the official SDK v2 primitives. Do not hand-roll a proxy.**

Phase 1 composition:

| Concern | Component |
|---|---|
| Downstream HTTP | `node:http` + `toNodeHandler(createMcpHandler(factory))` |
| DNS-rebinding / Origin guards | `localhostHostValidation()`, `localhostOriginValidation()` from `@modelcontextprotocol/node` |
| Per-request server instance | `McpServerFactory` returning a low-level `Server` |
| Known-method handling | `setRequestHandler('tools/list' \| 'tools/call', …)` |
| Unknown-method relay | `fallbackRequestHandler` + explicit permissive result schema |
| Upstream connection | `Client` with `versionNegotiation: { mode: 'auto' }` |
| Upstream stdio | `StdioClientTransport` (argv array, never a shell string) |
| Upstream HTTP | `StreamableHTTPClientTransport` |
| Demo servers | `McpServer` + `serveStdio` |

### Changes required to `ARCHITECTURE.md`

| # | Change | Severity |
|---|---|---|
| 1 | OD-1 resolved: no `Gateway` class; build on primitives (already recorded in Appendix C) | None |
| 2 | §23.4 conformance command must pin the **alpha** conformance release and carry a pre-1.0 caveat | **Minor — documented in §7 above** |
| 3 | §10.5 registry cache should reuse the SDK's `ResponseCacheStore` rather than reimplement | Simplification |
| 4 | Note that `versionNegotiation` defaults to `'legacy'` and must be set explicitly | Implementation detail |
| 5 | Add D-1 (relay must pass an explicit result schema for unknown methods) to the decision index | New decision |

None of these invalidate the architecture. Items 3–5 simplify or sharpen it; item 2 is a
tooling caveat that affects a claim, not a design.

---

## 10. Sources consulted

**Specification**
- [Specification (latest)](https://modelcontextprotocol.io/specification/latest)
- [Versioning](https://modelcontextprotocol.io/specification/versioning)
- [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Base protocol / statelessness / `_meta`](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)
- [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices)

**SDK / tooling**
- [SDKs and tiers](https://modelcontextprotocol.io/docs/2026-07-28/sdk) — TypeScript SDK is **Tier 1**
- [SDK tiering & conformance](https://modelcontextprotocol.io/community/sdk-tiers)
- [TypeScript SDK v2 — 2026-07-28 support](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [modelcontextprotocol/conformance](https://github.com/modelcontextprotocol/conformance)
- [Roadmap (updated 2026-08-22)](https://modelcontextprotocol.io/development/roadmap)

**Direct inspection (the authoritative source for every signature above)**
- `@modelcontextprotocol/server@2.0.0` — `dist/createMcpHandler-CLhGwQTn.d.mts`, `dist/index.d.mts`, `dist/stdio.d.mts`
- `@modelcontextprotocol/client@2.0.0` — `dist/index.d.mts`, `dist/stdio.d.mts`
- `@modelcontextprotocol/node@2.0.0` — `dist/index.d.mts`
- npm registry version and dist-tag queries
- `@modelcontextprotocol/conformance` CLI executed at `0.1.16` and `0.2.0-alpha.11`
