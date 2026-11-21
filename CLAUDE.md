# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build          # Compile src/{index,dev,cli}.ts via tsup → dist/
npm run build:binaries # bun build --compile → dist/bin/diiisco-<os>-<arch>[.exe] + SHA256SUMS
npm run build:binaries:desktop  # same matrix, stamped desktop-bundled → dist/bin/desktop/

# Run (development)
npm run dev            # bun run src/dev.ts — the contributor entry point
npm run cli            # bun run src/cli.ts — the CLI entry point
npm run serve          # Build then run dist/dev.js

# Test / typecheck
npm test               # bun test — smoke suite against the compiled binary
npm run typecheck      # tsc --noEmit

# Run (production, PM2)
npm run node:start     # Build and start as background service
npm run node:stop      # Stop
npm run node:restart   # Rebuild and restart
npm run node:logs      # Tail logs (last 100 lines)
npm run node:status    # PM2 process status
npm run node:monit     # Live resource monitor
```

The runtime target is **Bun** (see `.claude/docs/diiisco-cli.md`); Node 22 still runs the tsup output and PM2 path. TypeScript strict mode remains the primary correctness check, alongside the `bun test` suite under `test/`.

End users do not use any of the above — they install the `diiisco` binary and run `diiisco setup`, then `diiisco start` / `diiisco launch claude`.

## Architecture

DIIISCO is a peer-to-peer LLM inference marketplace. Nodes connect over libp2p, broadcast inference requests as quote auctions, settle in USDC via the **x402** protocol on Algorand, and expose an OpenAI-compatible HTTP API to clients.

### Entry points

There are three, and picking the wrong one is the classic mistake here:

- **`src/index.ts`** — the **library** export (`Application`, `configureEnvironment`, `DEFAULT_ENVIRONMENT`, `withDefaults`, `validateEnvironment`). It does **not** self-start; the desktop app and other consumers import it.
- **`src/dev.ts`** — the **contributor / PM2** entry. It applies an optional local `src/environment/environment.ts` override via a dynamic import, then instantiates `Application`, wires SIGTERM/SIGINT and calls `start()`. `npm run serve` and `pm2.config.cjs` both target `dist/dev.js`.
- **`src/cli.ts`** — the **`diiisco` CLI** (`src/cli/**`), the entry point compiled into the shipped binary.

`index.ts` deliberately has no self-start block: it used to, and under PM2 that made it start the node *while being imported* by the dev entry, double-starting it.

### Configuration

`src/environment/runtime.ts` holds the singleton config object, initialised from `src/environment/defaults.ts`. `configureEnvironment()` deep-merges overrides into it before the app starts. All internal modules import `runtime`, never `environment`.

Config comes from one of three places:

1. **`~/.diiisco/diiisco.config.json`** — how end users configure a node, created by `diiisco setup`. Mirrors the `Environment` interface; function-valued fields (`quoteSelectionFunction`) take strategy *names*, resolved by `src/environment/strategies.ts`. There is no implicit zero-config run: without this file the CLI exits **2** and tells the user to run `diiisco setup`. **The wallet mnemonic is not in this file** — see Wallet key below.
2. **`configureEnvironment(overrides)`** — how library consumers (the desktop app) configure it.
3. **`src/environment/environment.ts`** — an optional, **gitignored** contributor override loaded only by `src/dev.ts`. Copy `example.environment.ts` to create it. It typically holds a real mnemonic, so never commit it or read it into other tooling.

Two modes:

- **Public network** — requires an `algorand` block (algod client, network, `algorand.settlement` with a `maxSpend` budget plus x402 config) and a wallet key; settles payments in USDC via x402.
- **Private/local network** — omit `algorand`, add `local: { enabled: true, privateTopic: "..." }`. Quoting and settlement are skipped; an ephemeral signing key is generated instead.

**Paths.** Home and `~` resolution lives in `src/utils/paths.ts` (`userHome`,
`expandTilde`, `resolvePath`, `diiiscoHome`), re-exported by `src/cli/paths.ts`
so `src/libp2p/` can use it without importing the CLI layer. `~` expands via
`os.homedir()` — `%USERPROFILE%` on Windows — **never** `$HOME`, which is unset
there; expanding it with `$HOME` is how the peer identity used to be written to
`C:\.diiisco`. `userHome()` throws rather than falling back to the cwd or a
filesystem root, so a stripped environment fails loudly; `DIIISCO_HOME` is the
escape hatch. `loadConfig()` normalises `peerIdStorage.path` to an absolute path,
and `createDefaultEnvironment()` resolves its default, so the `dev.ts` and
library-consumer paths (which never run `mergeConfig()`) get an absolute one too.

**Network isolation** (`src/libp2p/networkGuard.ts`). A `local.enabled` node (network id `local-<hash of privateTopic>`, `getNetworkId()` in `src/utils/topic.ts`) is kept off the public network at the connection level, not just the GossipSub topic: it uses its own mDNS service tag and DHT protocol, ignores the public `lon`/`nyc` bootstrap servers (keeping any the operator added), and advertises a marker protocol `/diiisco/network/<id>/1.0.0` through identify. After identify it **refuses any peer without its own marker** (strict, so a mixed-version local cluster must upgrade together), except its configured bootstrap peers, and a `connectionGater` plus the discovery and reconnect paths never redial a refused peer for 10 minutes. Public nodes keep the default tag and DHT protocol, accept peers that predate the marker, and drop peers advertising a private marker. Peers are keyed by peer id.

**Several backends** (`models.backends`, plan 019, `src/utils/backendPool.ts`). `resolveBackends` turns either the single-backend fields or the `backends` list into endpoints; `InferenceBackends` holds one `OpenAIInferenceModel` (with that backend's own `apiKey`), `OllamaRuntime` and `ModelKindDetector` per backend and keeps the single-backend interface (`getResponse`, `chatTimed`, `systemOne`, `systemOneTimed`, `getModels`) plus the `RuntimeProbe` questions performance tracking asks (`isOllama`/`loaded`/`digest`/`unload`, per model). Each probe asks every backend in parallel and re-routes every model to the first backend listed that served it, so failover falls out of the 30 s poll. It fails only when every backend failed, and with a single backend it rethrows that backend's own error. `MessageProcessor`, `createApiServer` and `QuoteCreationFunction` take `InferenceService` (`getResponse`, `systemOne`, `countEmbeddings`), not the concrete class. In a config file `backends` beside `baseURL`/`port`/`apiKey` is a `ConfigError` (`mergeConfig` sees the raw file), and the effective config of a `backends` node drops the defaults' single-backend fields so `config show` output loads again. Backend names and addresses never leave the node.

**Model availability** (`models.availability`) governs how often the node re-checks that its backends really serve the models they advertise: `checkIntervalMs` (default 30000, `0` disables the background poll), `freshForMs` (default 10000 — the maximum snapshot age tolerated when answering a `quote-request`) and `timeoutMs` (default 2000). Probes are single-flight and fail closed: a backend that fails a probe loses its models at once, and when every backend fails the served set empties and the node stops quoting until one answers again. Kinds come from the source (the pool classifies per backend); the monitor's `kindDetector` option exists for tests.

**Tags** (`node.tags`, plan 018) are the operator's free-form hardware labels (`cuda`, `apple-silicon-m4-pro`), validated in `validateEnvironment` (lowercase, digits, hyphens; ≤ 48 chars; ≤ 16; no duplicates; a bad tag is an error, not dropped). They go in every quote and on the profile (even with `publicStats: false`: they are identity). `src/utils/nodeInfo.ts` holds the shape checks for tags and performance figures: `parseTags` / `parsePerformance` are pure, never throw, copy through only what they checked, and are the **only** validators for these fields wherever they arrive from a peer.

**Model performance** (`src/utils/modelPerformance.ts`, plan 018). Per chat model: time to first token hot and cold, and decode tokens/s; per decision model, the same two TTFT figures hold the end-to-end `/systemone` response time and there is no tokens/s (`isMeasured` in `src/types/performance.ts`; embeddings are not measured). Each figure is the median of its last 20 samples, persisted to `model-benchmarks.json` beside the peer identity (numbers only; debounced writes, flushed on shutdown). A `Benchmarker` seeds a model once, after the availability probe (`ModelAvailabilityMonitor.onModels`) shows a chat or decision model with no record (or, on Ollama, a changed digest), one model at a time in the background. Live inference then updates the figures through `OpenAIInferenceModel.observer`. A live sample moves hot/cold TTFT only when its prompt is ≤ 1024 tokens and its warmth is known: on Ollama `/api/ps` is asked just before each request (`src/utils/ollamaRuntime.ts`); elsewhere a model used in the last 5 minutes is hot and anything else unknown, so non-Ollama runtimes never get a cold figure. The Ollama benchmark unloads the model (`keep_alive: 0`) to force a real cold start. `models.benchmark.enabled: false` turns all of it off. `diiisco benchmark` re-measures via the `benchmark` control action when a daemon runs, and in-process against the backend when none does.

**Model kinds** (`src/utils/modelCapabilities.ts`). `/v1/models` carries no model type, so after each availability probe the node classifies every served model, against the runtime of the backend that listed it, as `chat`, `embedding` or `decision` and tags the listing entry with `kind` (and the raw `capabilities`, when known). DIIISCO fronts **any** OpenAI-compatible runtime, so detection is a pipeline of sources, first opinion wins: the operator's `models.kinds` override (ids or `*` globs; authoritative, works for any runtime) → what the `/v1/models` entry says about itself → a runtime's own listing (Ollama `/api/tags`, LM Studio `/api/v0/models`; a runtime that does not speak a dialect is not re-asked for 5 minutes) → an embedding-name heuristic → `chat`. Detection **fails open** (an unclassifiable model is still offered) and can never mark the backend unhealthy. Ollama lists `completion` on its decision models too, so `decision` wins over `completion`. A node only quotes — and `preferSelf` only serves — `chat` models for chat requests, and `GET /v1/models` returns chat models by default (`?type=embedding|decision|all` for the others), which is what keeps tool model pickers clean.

### Wallet key (`src/cli/keystore.ts`, `src/cli/keyMigration.ts`)

On the CLI/desktop path the 25-word mnemonic lives **on its own** in
`algorand-key.json` beside the config file (so `DIIISCO_HOME`, `$DIIISCO_CONFIG`
and `--config` move the two together), mode `0600`. It is out of
`diiisco.config.json` because that file gets hand-edited, pasted into issues and
copied between machines, and the mnemonic is full spending authority.

`loadConfig()` reads the key file and injects it into `env.algorand.mnemonic`, so
everything downstream (`src/utils/algorand.ts`, settlement, signing) is unchanged
— only the on-disk representation moved. `mergeConfig()` deliberately does *not*
read the key file: `setup` and `config edit` validate an in-memory candidate that
still carries its own mnemonic.

A config that still holds `algorand.mnemonic` is migrated on startup
(`runServe`, and `runStart` in the foreground so the user sees it): the key file
is written **first**, then the config is rewritten without the field, so a crash
between the two can never lose the key. If the two files name **different**
wallets the node stops and writes to neither — picking one would silently change
which account is spending. A source checkout's `src/environment/environment.ts`
keeps its inline mnemonic and is unaffected.

### Transport layer (`src/libp2p/`)

`node.ts` creates the libp2p node: TCP transport, Noise encryption, Yamux muxing, GossipSub pubsub, Kademlia DHT, mDNS, AutoNAT, circuit relay, and libp2p's connection monitor (pings every connection, with a 20-60 s timeout, and aborts one that fails; there is no separate app-level ping loop). A public node's relay server cuts each relayed connection at `node.relay.connectionMinutes` (default 60) or `node.relay.connectionMegabytes` (default 100); relayed connections closing are logged with how long they lasted. Bootstrap servers accept raw multiaddrs **or** `.diiisco.algo` NFD names (resolved via `nfdToNodeAddress`). The peer identity is persisted as `diiisco-peer-id.protobuf` at the path in `peerIdStorage.path`, written once (mode `0600`; an older world-readable file is tightened at startup). **An existing file that cannot be read stops the node** — it is never regenerated over, because NFD verification and every peer that knows the node are bound to the id.

**Sleep.** A node that serves has to stay reachable, so while it runs the daemon holds the OS's idle-sleep assertion (`src/utils/keepAwake.ts`: `caffeinate -i -w <pid>` on macOS, a hidden PowerShell holding `SetThreadExecutionState` on Windows, `systemd-inhibit … cat` on Linux — the last two are tied to the node by a stdin pipe, so they cannot outlive it). It is on by default (`power.preventSleep: false` opts out), never fails the node, and does not fight a lid-close or an explicit Sleep. When the machine sleeps anyway, `startSleepDetector` notices the wall-clock jump and `recoverAfterWake` (in `reconnection.ts`) retries the bootstrap dial on a backoff until a connection exists, then waits for mesh subscribers and re-announces the subscription if there are none.

`reconnection.ts` provides health-check polling and exponential-backoff reconnect logic. `meshReadinessMonitor.ts` tracks GossipSub mesh readiness using events rather than polling.

### Messaging pipeline

All on-wire messages are msgpack-encoded (`msgpackr`) and typed by `role` field (see `src/types/messages.ts`). Every byte is a stranger's, and an unhandled rejection exits the process (`installProcessGuards`), so decode goes through `parseWireMessage` (`src/messaging/wire.ts`: never throws, returns `null` unless the shape is plausible), `process()` treats a throwing verification as a rejection, and `quoteEngine` / `ModelListCollector` validate what a peer sends before it enters a queue a timer later reads. Anything new that reads peer data in a timer or listener must do the same.

**Message flow for an inference request:**
1. API server receives `POST /v1/chat/completions`
2. The requester counts its **own** input tokens (prompt **and** tool schemas — an agent tool's schemas are thousands of tokens the provider must be paid for); `MeshMessageQueue` (`src/messaging/meshMessageQueue.ts`) publishes a `quote-request` carrying `{ model, inputTokenCount, max_tokens, maxSpend }` — **not the prompt** — once the GossipSub mesh has a subscriber
3. Provider nodes receive `quote-request` → `MessageProcessor.handleQuoteRequest()` → publish `quote-response` with their per-token rates. A provider only quotes for a model its backend is **currently** serving — availability is re-verified against the backend here (`src/utils/modelAvailability.ts`), not read from a startup snapshot — and providers that can't serve within the budget don't quote
4. `quoteEngine` enriches each quote (provider DSCO balance, NFD status, response latency) and after `waitTime` ms selects one via `quoteSelectionFunction`, emitting `quote-selected-<id>`
5. Requester sends `quote-accepted` **directly to the winning provider only**, now including the prompt content and any `tools` definitions
6. Provider runs inference (generation capped to what the budget affords), **withholds** the answer, and sends `contract-created` carrying the x402 payment requirements for the metered charge (`min(actual, maxSpend)`)
7. Requester checks the amount against its **local** `maxSpend`, signs the USDC transfer, and returns it in `contract-signed` (it refuses if the amount exceeds `maxSpend`, or if `maxSpend` is unset)
8. Provider verifies the payment with the facilitator, releases the answer as `inference-response`, then settles on-chain in the background (facilitator settle, with a direct-to-algod self-submit fallback)

**Local mode** skips settlement entirely — `quote-accepted` triggers inference and returns `inference-response` directly.

**When a provider can't deliver.** If inference fails at any point after the quote was accepted — the operator stopped Ollama between steps 5 and 6 is the usual case — the provider sends `inference-failed` (model + a coarse reason, never the prompt or a partial answer) and re-probes its own backend, so it drops out of the next auction. The requester excludes that provider and re-auctions the request (`quoteEngine.maxRetries`, default 1). Backing all of this up, the requester holds two deadlines: `quoteEngine.auctionTimeout` (no quote selected → 503) and `quoteEngine.inferenceTimeout` (no answer → 504). A request that can't be served now fails; it does not hang.

**Message routing** (`src/messaging/messageRouter.ts`): discovery-phase messages (`quote-request`, `list-models`, `list-network`) go via GossipSub broadcast. Post-selection messages (`quote-accepted`, `contract-*`, `inference-response`, `inference-failed`) are the `PRIVATE_ROLES`: they carry the prompt, the payment and the completion, so they go over a direct libp2p stream (`DirectMessagingHandler`) and are **never** published to GossipSub — a failed direct send throws, and for `quote-accepted` the requester re-auctions. Only the non-private profile roles may fall back (`directMessaging.fallbackToGossipsub`). A direct message is capped on the reader (`directMessaging.maxMessageSize`, default 10 MB) and the API answers 413 for a request that cannot fit in one.

**What `process()` does before a handler runs**, in order: a per-peer token bucket (`node.rateLimit`; our own messages exempt), the per-role payload shape check (`payloadProblem`, `wire.ts`), the timestamp window (`node.clockSkewToleranceMs`, default 5 min), the signature, then a replay check on broadcast request ids (recorded only after the signature verifies). A `list-models-response` is kept only for a `list-models` request this node has open (`ModelListCollector`, one answer per peer, bounded), and a `list-network-response` must describe the peer that sent it. Anything a stranger can provoke that costs an algod lookup goes through `algorand.checkIfOptedInToAsset(..., { cache: true })`, which caches, shares and caps concurrent lookups. A provider quotes only for a requester that is opted in to USDC with a balance covering its input.

**Settlement is durable.** An accepted payment is written to `pending-settlements.json` (beside the peer identity, `0600`) before it is settled and removed only on success; `resumeSettlements()` retries what a restart left, until the payment's transaction can no longer be submitted (~50 min). `GET /health/algorand` reports `unsettledPayments`.

All messages are signed with the Algorand account key and verified by `MessageProcessor.process()` before any handling.

### Algorand integration (`src/utils/algorand.ts`, `src/utils/diiiscoAssets.ts`)

Handles wallet initialization (the account is derived from the mnemonic), asset opt-in (DSCO + USDC), and NFD resolution/verification. `diiiscoAssets.ts` holds the per-network USDC and DSCO asset ids, selected by `algorand.network`. On startup the node opts into the DSCO and USDC assets if needed (requires a small ALGO balance). There is no DIIISCO smart contract anymore — escrow was retired in favour of x402 (see Settlement).

### Settlement (`src/settlement/`)

`SettlementProvider` (`settlementProvider.ts`) is the settlement seam; `X402Settlement` (`x402Settlement.ts`) implements it over the x402 protocol (`@x402/core`, `@x402/avm`) against a facilitator. The charge is **bounded by the requester's `maxSpend`** (`algorand.settlement.maxSpend`): the provider budget-caps generation to what the budget affords and charges the metered `min(actual, maxSpend)`, while the requester refuses to sign any amount above its **local** `maxSpend` (and refuses if unset) — so it can never be overcharged, whatever a provider claims. Settlement is a single on-chain USDC transfer submitted via the facilitator, with a direct-to-algod self-submit fallback and a retry on facilitator `verify`.

**Nothing in the payment flow is taken on the other side's word, and peers are identified by peer id, not wallet.** Several nodes may share one Algorand address, and a wallet signature only proves a message came from *a* holder of that key; the peer id is authenticated by the transport and is unique per node. So per-request state is keyed by (peer id, request id) and every sender check compares peer ids. Wallets appear only as the *payee*.

- **Provider** (`MessageProcessor`): `handleQuoteRequest` records an `IssuedQuote` (model, kind, the rates it quoted, the budget it was quoted for) per requester peer. A `quote-accepted` is honoured only for a quote issued to that peer, for that model, and spends it (a replay finds nothing). Generation is capped, and the charge metered, from the *recorded* rates — never the `quote` the requester echoes back — and a backend that reports no `usage` is counted locally rather than billed as free. The challenge issued (`IssuedContract`: requirements + the withheld completion) is kept per requester peer, **single-use**: `contract-signed` consumes it, and `X402Settlement.verifyPayment` requires the requester's echoed `accepted` to match the *issued* requirements field for field, then hands the facilitator the issued requirements, not the echo. A payment transaction id is accepted once (`usedPayments`, in memory, one hour), because requirements carry no quote id. `selfSubmit` checks the transfer's asset, amount and receiver before submitting.
- **Requester** (`RequestLedger`, `src/messaging/requestLedger.ts`): `server.ts` opens each auction in the ledger before publishing the `quote-request`, then records the provider peer id and its quote-signing wallet when it picks a quote. A `quote-response` is queued only while its auction is still collecting quotes, and only if its `addr` (where stake is read from) is the wallet that signed it — a stranger's quote, a late one, or one borrowing another wallet's DSCO stake is dropped. `handleContractCreated` signs only for a recorded request, from that peer, once (`claimPayment`), via `settlement.checkRequest` (scheme `exact`, our network, USDC, `payTo` = the wallet that signed the quote, integer amount, no `feePayer`), and within local `maxSpend`. `inference-response` and `inference-failed` are accepted only from the selected peer (the event carries the transport-authenticated `from`). The `providerPeerId` stamped inside a quote is the provider's own claim and is not used for any of this.
- There is no cumulative spend limit by decision: the wallet balance is the bound, `maxSpend` bounds each request.

### Quote engine (`src/utils/quoteEngine.ts`)

Collects `QuoteResponse` messages per request, enriches each into a `QuoteCandidate` (provider DSCO balance, verified-NFD status, response latency), then after `waitTime` ms selects one via `quoteSelectionFunction`. Built-in strategies (`src/utils/quoteSelectionMethods.ts`): `selectHighestStakeQuote` (default — most DSCO, tie-broken on NFD then latency), `selectCheapestQuote`, `selectFastestQuote`; a single function or a list (tried in order) may be configured. Each quote also carries the provider's `tags` and its `performance` for the model (always, whatever `publicStats` says: only the requester sees a quote). Both are self-reported: `isValidQuoteResponse` rejects a quote whose claims fail `parseTags` / `parsePerformance`, and the cleaned values ride on `QuoteCandidate.tags` / `.performance`. No built-in strategy uses them yet. Pricing is per-token rates from `chargePer1MTokens`; `createStandardQuote` (`quoteCreationMethods.ts`) is the default `quoteCreationFunction`, overridable for dynamic pricing.

### HTTP API (`src/api/server.ts`)

Express 5 server exposing an OpenAI-compatible API. It binds **`api.host`, default `127.0.0.1`** — every request runs an auction the wallet pays for, so the API is the wallet's front door and is loopback-only unless the operator opts in (`0.0.0.0` serves other machines; setup, `config show`/`edit` and startup warn when a public-mode node has no `bearerAuthentication`). CORS sends no headers unless `bearerAuthentication` is on, and then only for `api.corsOrigins`. While the API is unauthenticated *and* loopback-bound, requests whose `Host` is not a loopback address, the host of `node.url`, or in `api.allowedHosts` get a 403 (DNS-rebinding guard); a non-loopback bind is exempt, since its clients arrive under their own addresses. All `/v1`, `/peers`, `/network`, and `/health/algorand` endpoints require `Authorization: Bearer <key>` when `bearerAuthentication` is true. `/health` is always unauthenticated.

`/v1/messages` (+ `/v1/messages/count_tokens`) speaks the **Anthropic** Messages API, which is what `diiisco launch claude` points Claude Code at. `src/api/anthropicAdapter.ts` translates it to and from the internal OpenAI shape: text blocks, tool definitions (`input_schema` → `parameters`), `tool_use` → `tool_calls`, `tool_result` → `role: "tool"` messages, and back again. Claude Code always sends `stream: true`, so the completed response is re-framed as a batched SSE stream (one delta per content block) — there is no incremental generation towards clients. Towards the **backend**, `getResponse` does stream (since 1.0.14), purely to time it: the chunks are rebuilt into the same `ChatCompletion` (content, `reasoning_content`/`reasoning`, tool calls merged by index, `finish_reason`, `usage`), so callers and billing are unchanged. A stream that ends without a `finish_reason` is a failure (a dropped connection ends the SDK's iteration quietly, and a truncated answer must not be billed). A backend that rejects streaming with a 4xx before the first chunk is asked plainly, and that model is not streamed again. Images and extended thinking are still dropped. `stop_reason: "tool_use"` is set from the blocks actually built, never from `finish_reason` alone.

`POST /v1/systemone` is the **System One** endpoint for decision models (Tev, Nimble, Jev): `{ state, model, questions }` in, `{ model, answers, usage }` out, defined by TypeSafe (`docs.typesafe.ai/api.md`) and carried across the mesh unchanged. It reuses the whole auction: the `quote-request` carries `kind: "systemone"` and an input-token count over the state + questions (`countSystemOneInputTokens`), only a `decision` model may quote for it (and only a `chat` model for anything else), and `quote-accepted` carries `{ state, questions }` instead of `messages`. The provider calls `{models.baseURL}:{models.port}/v1/systemone` on its backend (`OpenAIInferenceModel.systemOne`, a plain `fetch`: nothing Ollama-specific), validates the request again, and settles on the backend-reported `usage` (`input_tokens`/`output_tokens`, read by `normalizeUsage`). A backend that rejects the request fails the quote with `inference-failed` like any other provider failure.

`preferSelf: true` (default) short-circuits the network auction — if the requested model is available locally, inference runs directly without broadcasting.

### CLI (`src/cli.ts`, `src/cli/**`)

The `diiisco` command, shipped as a self-contained Bun-compiled binary (no Node, npm or PM2 on the host). Commands: `setup`, `start`/`stop`/`restart`/`status`/`logs`/`serve`, `peers`, `benchmark`, `launch <app>`, `config show|path|edit`, `version`, `help`.

- **Lifecycle is self-managed**, not PM2: `start` re-spawns the executable detached with an internal `__daemon` argument and records `{pid, endpoint, version, owner}` in `~/.diiisco/daemon.json`. `owner` (`cli` or `desktop`) lets the desktop app and the terminal share one daemon rather than fight over it. Readiness is read over the daemon's loopback control channel (`src/cli/control.ts`, `status` action), not the API's `/health`, so a node with `api.enabled: false` (inference only) starts and reports healthy; `launch` refuses such a node because there is no API to connect to.
- **`launch <app>`** points an agent tool at the node by setting wire env vars (`anthropic`: `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_API_KEY` explicitly blanked; `openai`: `OPENAI_BASE_URL`/`OPENAI_API_KEY`) and spawning it with inherited stdio. Flags must precede the app name — everything after it is passed through to the tool verbatim.
- **`--json` output** on `status`, `config show` and `launch --list` is a **contract consumed by DIIISCO Desktop**; changing those shapes breaks the app. Exit codes: 0 success, 1 failure, **2 not configured**.
- Runtime state lives in `~/.diiisco/` (`DIIISCO_HOME` overrides): `diiisco.config.json`, `algorand-key.json`, `diiisco-peer-id.protobuf`, `model-benchmarks.json`, `daemon.json`, `logs/`. `config path --key` prints the key file's location — DIIISCO Desktop asks the binary rather than re-deriving the precedence.

See `.claude/docs/plans/003-diiisco-cli.md` for the full spec, including packaging, `install.sh`, and the Electrobun desktop integration.

## Development principles

These came out of the 1.0.12 review (see `.claude/docs/plans/016-release-1.0.13-remediation.md`). Where a check enforces one, it is named.

1. **Check before adding a dependency.** Look for something already installed or written that does the job; remove a dependency in the same change that stops using it. *Enforced:* `npm run check:deps` (`scripts/check-deps.mjs`; also in `release.yml`) fails on an unused or undeclared dependency.
2. **No dead code.** *Enforced:* `noUnusedLocals` and `noUnusedParameters` in `tsconfig.json` (prefix a deliberately unused parameter with `_`).
3. **Extend before you duplicate.** Before writing a new request/response flow, timeout, id generator or rate limiter, find the existing one (`collect()` in `src/api/collect.ts`, `newRequestId()`, `RateLimiter`, `ExpiringMap`, `RequestLedger`, `guarded()`) and generalise it.
4. **Every inbound message is hostile.** A handler states what it checks — sender identity, an open request of ours, size, freshness, rate — before it does work or I/O; no unsolicited message may start a timer, allocate without bound or query an external service. Anything that reads peer data later (a timer, a listener) validates it on arrival. *Enforced:* `test/untrustedInput.test.ts`, `wirePayloads.test.ts`, `messageFreshness.test.ts`, `peerRateLimit.test.ts`.
5. **Privacy is a property of the transport.** Prompts, payments and completions never fall back to a broadcast channel; failure means the request fails or is retried. *Enforced:* `test/messageRouter.test.ts`.
6. **Defaults are safe, not convenient.** No default credentials; a known default secret is a validation error, not a warning.
7. **Keep generated and binary artefacts out of git** unless there is a stated reason (the web manifest has one: `scripts/build-web-manifest.mjs`). One installer per platform.
8. **Nothing the process does on its own may crash it.** Listeners and timers nobody awaits are wrapped in `guarded()` (`src/utils/processGuards.ts`); a background chain keeps its state somewhere a restart can find it (see the settlement queue).
9. **Comments explain constraints, not code.** Say why something is the way it is when it would otherwise look wrong; do not restate the next line.
10. **Tests prove invariants, not coverage.** Each security fix lands with a test that fails without it. A change that adds a subsystem says in its plan what it replaces.
