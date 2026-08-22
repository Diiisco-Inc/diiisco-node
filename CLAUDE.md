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

`node.ts` creates the libp2p node: TCP transport, Noise encryption, Yamux muxing, GossipSub pubsub, Kademlia DHT, mDNS, AutoNAT, circuit relay, and a keep-alive ping loop. Bootstrap servers accept raw multiaddrs **or** `.diiisco.algo` NFD names (resolved via `nfdToNodeAddress`). The peer identity is persisted as `diiisco-peer-id.protobuf` at the path in `peerIdStorage.path`.

`reconnection.ts` provides health-check polling and exponential-backoff reconnect logic. `meshReadinessMonitor.ts` tracks GossipSub mesh readiness using events rather than polling.

### Messaging pipeline

All on-wire messages are msgpack-encoded (`msgpackr`) and typed by `role` field (see `src/types/messages.ts`).

**Message flow for an inference request:**
1. API server receives `POST /v1/chat/completions`
2. The requester counts its **own** input tokens (prompt **and** tool schemas — an agent tool's schemas are thousands of tokens the provider must be paid for); `MeshMessageQueue` (`src/messaging/meshMessageQueue.ts`) publishes a `quote-request` carrying `{ model, inputTokenCount, max_tokens, maxSpend }` — **not the prompt** — once the GossipSub mesh has a subscriber
3. Provider nodes receive `quote-request` → `MessageProcessor.handleQuoteRequest()` → publish `quote-response` with their per-token rates (providers that can't serve within the budget don't quote)
4. `quoteEngine` enriches each quote (provider DSCO balance, NFD status, response latency) and after `waitTime` ms selects one via `quoteSelectionFunction`, emitting `quote-selected-<id>`
5. Requester sends `quote-accepted` **directly to the winning provider only**, now including the prompt content and any `tools` definitions
6. Provider runs inference (generation capped to what the budget affords), **withholds** the answer, and sends `contract-created` carrying the x402 payment requirements for the metered charge (`min(actual, maxSpend)`)
7. Requester checks the amount against its **local** `maxSpend`, signs the USDC transfer, and returns it in `contract-signed` (it refuses if the amount exceeds `maxSpend`, or if `maxSpend` is unset)
8. Provider verifies the payment with the facilitator, releases the answer as `inference-response`, then settles on-chain in the background (facilitator settle, with a direct-to-algod self-submit fallback)

**Local mode** skips settlement entirely — `quote-accepted` triggers inference and returns `inference-response` directly.

**Message routing** (`src/messaging/messageRouter.ts`): discovery-phase messages (`quote-request`, `list-models`, `list-network`) go via GossipSub broadcast. Post-selection messages (`quote-accepted`, `contract-*`, `inference-response`) use direct libp2p streams (`DirectMessagingHandler`) with GossipSub fallback.

All messages are signed with the Algorand account key and verified by `MessageProcessor.process()` before any handling.

### Algorand integration (`src/utils/algorand.ts`, `src/utils/diiiscoAssets.ts`)

Handles wallet initialization (the account is derived from the mnemonic), asset opt-in (DSCO + USDC), and NFD resolution/verification. `diiiscoAssets.ts` holds the per-network USDC and DSCO asset ids, selected by `algorand.network`. On startup the node opts into the DSCO and USDC assets if needed (requires a small ALGO balance). There is no DIIISCO smart contract anymore — escrow was retired in favour of x402 (see Settlement).

### Settlement (`src/settlement/`)

`SettlementProvider` (`settlementProvider.ts`) is the settlement seam; `X402Settlement` (`x402Settlement.ts`) implements it over the x402 protocol (`@x402/core`, `@x402/avm`) against a facilitator. The charge is **bounded by the requester's `maxSpend`** (`algorand.settlement.maxSpend`): the provider budget-caps generation to what the budget affords and charges the metered `min(actual, maxSpend)`, while the requester refuses to sign any amount above its **local** `maxSpend` (and refuses if unset) — so it can never be overcharged, whatever a provider claims. Settlement is a single on-chain USDC transfer submitted via the facilitator, with a direct-to-algod self-submit fallback and a retry on facilitator `verify`.

### Quote engine (`src/utils/quoteEngine.ts`)

Collects `QuoteResponse` messages per request, enriches each into a `QuoteCandidate` (provider DSCO balance, verified-NFD status, response latency), then after `waitTime` ms selects one via `quoteSelectionFunction`. Built-in strategies (`src/utils/quoteSelectionMethods.ts`): `selectHighestStakeQuote` (default — most DSCO, tie-broken on NFD then latency), `selectCheapestQuote`, `selectFastestQuote`; a single function or a list (tried in order) may be configured. Pricing is per-token rates from `chargePer1MTokens`; `createStandardQuote` (`quoteCreationMethods.ts`) is the default `quoteCreationFunction`, overridable for dynamic pricing.

### HTTP API (`src/api/server.ts`)

Express 5 server exposing an OpenAI-compatible API. All `/v1`, `/peers`, `/network`, and `/health/algorand` endpoints require `Authorization: Bearer <key>` when `bearerAuthentication` is true. `/health` is always unauthenticated.

`/v1/messages` (+ `/v1/messages/count_tokens`) speaks the **Anthropic** Messages API, which is what `diiisco launch claude` points Claude Code at. `src/api/anthropicAdapter.ts` translates it to and from the internal OpenAI shape: text blocks, tool definitions (`input_schema` → `parameters`), `tool_use` → `tool_calls`, `tool_result` → `role: "tool"` messages, and back again. Claude Code always sends `stream: true`, so the completed response is re-framed as a batched SSE stream (one delta per content block) — there is no incremental generation anywhere in the node. Images and extended thinking are still dropped. `stop_reason: "tool_use"` is set from the blocks actually built, never from `finish_reason` alone.

`preferSelf: true` (default) short-circuits the network auction — if the requested model is available locally, inference runs directly without broadcasting.

### CLI (`src/cli.ts`, `src/cli/**`)

The `diiisco` command, shipped as a self-contained Bun-compiled binary (no Node, npm or PM2 on the host). Commands: `setup`, `start`/`stop`/`restart`/`status`/`logs`/`serve`, `launch <app>`, `config show|path|edit`, `version`, `help`.

- **Lifecycle is self-managed**, not PM2: `start` re-spawns the executable detached with an internal `__daemon` argument and records `{pid, endpoint, version, owner}` in `~/.diiisco/daemon.json`. `owner` (`cli` or `desktop`) lets the desktop app and the terminal share one daemon rather than fight over it.
- **`launch <app>`** points an agent tool at the node by setting wire env vars (`anthropic`: `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_API_KEY` explicitly blanked; `openai`: `OPENAI_BASE_URL`/`OPENAI_API_KEY`) and spawning it with inherited stdio. Flags must precede the app name — everything after it is passed through to the tool verbatim.
- **`--json` output** on `status`, `config show` and `launch --list` is a **contract consumed by DIIISCO Desktop**; changing those shapes breaks the app. Exit codes: 0 success, 1 failure, **2 not configured**.
- Runtime state lives in `~/.diiisco/` (`DIIISCO_HOME` overrides): `diiisco.config.json`, `algorand-key.json`, `diiisco-peer-id.protobuf`, `daemon.json`, `logs/`. `config path --key` prints the key file's location — DIIISCO Desktop asks the binary rather than re-deriving the precedence.

See `.claude/docs/plans/003-diiisco-cli.md` for the full spec, including packaging, `install.sh`, and the Electrobun desktop integration.
