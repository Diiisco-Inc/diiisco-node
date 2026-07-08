# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build          # Compile TypeScript via tsup → dist/

# Run (development)
npm run serve          # Build then run dist/index.js directly

# Run (production, PM2)
npm run node:start     # Build and start as background service
npm run node:stop      # Stop
npm run node:restart   # Rebuild and restart
npm run node:logs      # Tail logs (last 100 lines)
npm run node:status    # PM2 process status
npm run node:monit     # Live resource monitor
```

No test suite exists yet. There is no lint script; TypeScript strict mode is the primary correctness check (`npx tsc --noEmit`).

## Architecture

DIIISCO is a peer-to-peer LLM inference marketplace. Nodes connect over libp2p, broadcast inference requests as quote auctions, settle via Algorand smart contracts, and expose an OpenAI-compatible HTTP API to clients.

### Entry point

`src/index.ts` exports the `Application` class and `configureEnvironment`. When run directly (or under PM2), it instantiates `Application`, wires SIGTERM/SIGINT, and calls `app.start()`. It can also be imported as a library — call `configureEnvironment(overrides)` before `new Application()`.

### Configuration

`src/environment/environment.ts` holds the singleton config object. `configureEnvironment()` deep-merges overrides into it before the app starts. Copy `src/environment/example.environment.ts` to `src/environment/environment.ts` to get started. Two modes:

- **Public network** — requires `algorand` block with wallet mnemonic; settles payments in USDC on-chain.
- **Private/local network** — omit `algorand`, add `local: { enabled: true, privateTopic: "..." }`. Payments are skipped; an ephemeral signing key is generated instead.

### Transport layer (`src/libp2p/`)

`node.ts` creates the libp2p node: TCP transport, Noise encryption, Yamux muxing, GossipSub pubsub, Kademlia DHT, mDNS, AutoNAT, circuit relay, and a keep-alive ping loop. Bootstrap servers accept raw multiaddrs **or** `.diiisco.algo` NFD names (resolved via `nfdToNodeAddress`). The peer identity is persisted as `diiisco-peer-id.protobuf` at the path in `peerIdStorage.path`.

`reconnection.ts` provides health-check polling and exponential-backoff reconnect logic. `meshReadinessMonitor.ts` tracks GossipSub mesh readiness using events rather than polling.

### Messaging pipeline

All on-wire messages are msgpack-encoded (`msgpackr`) and typed by `role` field (see `src/types/messages.ts`).

**Message flow for an inference request:**
1. API server receives `POST /v1/chat/completions`
2. `MeshMessageQueue` (`src/messaging/meshMessageQueue.ts`) holds the message until GossipSub mesh has at least one subscriber, then publishes a `quote-request` via GossipSub
3. Provider nodes receive `quote-request` → `MessageProcessor.handleQuoteRequest()` → publish `quote-response`
4. `quoteEngine` collects responses for `waitTime` ms, then emits `quote-selected-<id>`
5. Requester sends `quote-accepted` → provider creates on-chain escrow (`contract-created`) → requester funds it (`contract-signed`) → inference runs → `inference-response` returned
6. Requester calls `algo.completeQuote()` to release payment

**Local mode** skips steps 5's contract steps entirely — `quote-accepted` triggers `executeInference` directly.

**Message routing** (`src/messaging/messageRouter.ts`): discovery-phase messages (`quote-request`, `list-models`, `list-network`) go via GossipSub broadcast. Post-selection messages (`quote-accepted`, `contract-*`, `inference-response`) use direct libp2p streams (`DirectMessagingHandler`) with GossipSub fallback.

All messages are signed with the Algorand account key and verified by `MessageProcessor.process()` before any handling.

### Algorand integration (`src/utils/algorand.ts`, `src/utils/contract.ts`)

Handles wallet initialization, asset opt-in (DSCO + USDC), smart contract registration, quote creation/funding/completion, and NFD resolution. On startup, the node auto-opts into assets and registers with the DIIISCO smart contract if not already done (requires a small ALGO balance).

### Quote engine (`src/utils/quoteEngine.ts`)

Collects `QuoteResponse` messages into a per-request queue, then after `waitTime` ms selects one using the configured `quoteSelectionFunction`. Built-in strategies: `selectHighestStakeQuote` (public network default) and `selectFirstQuote` (local mode default). Pricing is computed by `quoteCreationFunction` — built-in: `createQuoteFromInputTokens` (counts tokens via llama-tokenizer-js × configured rate).

### HTTP API (`src/api/server.ts`)

Express 5 server exposing an OpenAI-compatible API. All `/v1`, `/peers`, `/network`, and `/health/algorand` endpoints require `Authorization: Bearer <key>` when `bearerAuthentication` is true. `/health` is always unauthenticated.

`preferSelf: true` (default) short-circuits the network auction — if the requested model is available locally, inference runs directly without broadcasting.
