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

DIIISCO is a peer-to-peer LLM inference marketplace. Nodes connect over libp2p, broadcast inference requests as quote auctions, settle in USDC via the **x402** protocol on Algorand, and expose an OpenAI-compatible HTTP API to clients.

### Entry point

`src/index.ts` exports the `Application` class and `configureEnvironment`. When run directly (or under PM2), it instantiates `Application`, wires SIGTERM/SIGINT, and calls `app.start()`. It can also be imported as a library — call `configureEnvironment(overrides)` before `new Application()`.

### Configuration

`src/environment/environment.ts` holds the singleton config object. `configureEnvironment()` deep-merges overrides into it before the app starts. Copy `src/environment/example.environment.ts` to `src/environment/environment.ts` to get started. Two modes:

- **Public network** — requires `algorand` block with a wallet mnemonic and an `algorand.settlement` block (a `maxSpend` budget plus x402 config); settles payments in USDC via x402.
- **Private/local network** — omit `algorand`, add `local: { enabled: true, privateTopic: "..." }`. Quoting and settlement are skipped; an ephemeral signing key is generated instead.

### Transport layer (`src/libp2p/`)

`node.ts` creates the libp2p node: TCP transport, Noise encryption, Yamux muxing, GossipSub pubsub, Kademlia DHT, mDNS, AutoNAT, circuit relay, and a keep-alive ping loop. Bootstrap servers accept raw multiaddrs **or** `.diiisco.algo` NFD names (resolved via `nfdToNodeAddress`). The peer identity is persisted as `diiisco-peer-id.protobuf` at the path in `peerIdStorage.path`.

`reconnection.ts` provides health-check polling and exponential-backoff reconnect logic. `meshReadinessMonitor.ts` tracks GossipSub mesh readiness using events rather than polling.

### Messaging pipeline

All on-wire messages are msgpack-encoded (`msgpackr`) and typed by `role` field (see `src/types/messages.ts`).

**Message flow for an inference request:**
1. API server receives `POST /v1/chat/completions`
2. The requester counts its **own** input tokens; `MeshMessageQueue` (`src/messaging/meshMessageQueue.ts`) publishes a `quote-request` carrying `{ model, inputTokenCount, max_tokens, maxSpend }` — **not the prompt** — once the GossipSub mesh has a subscriber
3. Provider nodes receive `quote-request` → `MessageProcessor.handleQuoteRequest()` → publish `quote-response` with their per-token rates (providers that can't serve within the budget don't quote)
4. `quoteEngine` enriches each quote (provider DSCO balance, NFD status, response latency) and after `waitTime` ms selects one via `quoteSelectionFunction`, emitting `quote-selected-<id>`
5. Requester sends `quote-accepted` **directly to the winning provider only**, now including the prompt content
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

`preferSelf: true` (default) short-circuits the network auction — if the requested model is available locally, inference runs directly without broadcasting.
