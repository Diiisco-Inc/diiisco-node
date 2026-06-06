<img src="https://github.com/Diiisco-Inc/diiisco-node/blob/main/assets/diiisco-logo.png?raw=true" width="1000" />


<p align="center">
  <a href="https://diiisco.com"><img src="https://img.shields.io/badge/Website-diiisco.com-black?style=flat-square&logoColor=white" alt="Website" /></a>
  &nbsp;
  <a href="https://diiisco.com/docs/welcome"><img src="https://img.shields.io/badge/Docs-diiisco.com/docs-black?style=flat-square&logoColor=white" alt="Docs" /></a>
  &nbsp;
  <a href="https://x.com/diiiscohq"><img src="https://img.shields.io/badge/X-@diiiscohq-black?style=flat-square&logo=x&logoColor=white" alt="X" /></a>
  &nbsp;
  <a href="https://discord.gg/WcuuVcrHFa"><img src="https://img.shields.io/badge/Discord-Join_Us-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
</p>

DIIISCO is a peer-to-peer network for running large language models. Any node on the network can send an inference request; any node running a compatible model can fulfil it and earn, settled instantly on Algorand.

DIIISCO is open-source and free forever. Any application that calls an OpenAI Copatable API can be used with DIIISCO.

---

## 🪩 How DIIISCO works

When a request arrives at a DIIISCO node, it is broadcast to the network as a quote request. Nodes that can serve the model respond with a price. The best quote is selected, an on-chain escrow contract is created, inference runs, and payment is released automatically on delivery. Nodes that don't need payment such as private clusters, skip the contract entirely and serve inference directly overf the network.

### Public network (payments enabled)

Nodes connect to the global DIIISCO network. Requesters pay providers in USDC; providers earn DSCO tokens as an additional reward. Requires an Algorand wallet on each node.

### Private network (payments disabled)

A cluster of nodes you control, isolated from the public network by a unique topic name. No Algorand wallets required — nodes generate an ephemeral signing key at startup. Useful for home labs, office clusters, or any situation where you want distributed inference without blockchain overhead.

---

## 📋 Requirements

- **Node.js 22** or higher
- **An LLM runtime** — [Ollama](https://ollama.com/) or any OpenAI-compatible backend (e.g. [Shimmy](https://github.com/Michael-A-Kuykendall/shimmy))
- **An Algorand wallet** — required for the public network only (we recommend [Pera Wallet](https://perawallet.app/))

> ⚠️ **Never share your mnemonic.** Never enter it on a device you don't control.

---

## 📦 Installation

```bash
git clone https://github.com/Diiisco-Inc/diiisco-node.git
cd diiisco-node
npm install
```

---

## ⚙️ Configuration

Copy the example configuration and edit it:

```bash
cp src/environment/example.environment.ts src/environment/environment.ts
```

### 🌐 Public network configuration

```typescript
import { Environment } from "./environment.types";
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";
import { createQuoteFromInputTokens } from "../utils/quoteCreationMethods";

const environment: Environment = {
  peerIdStorage: {
    path: "~/Desktop/"               // Where to store your persistent peer identity
  },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,                     // Default Ollama port
    apiKey: "",                      // Usually not needed for local LLMs
    chargePer1MTokens: {
      default: 0.01703,              // Price per 1M tokens in USDC
      "llama3:8b": 0.01,             // Per-model price override
    }
  },
  algorand: {
    addr: "YOUR_ALGORAND_ADDRESS",
    mnemonic: "YOUR_25_WORD_MNEMONIC",
    network: "mainnet",
    client: {
      address: "https://mainnet-api.algonode.cloud/",
      port: 443,
      token: ""
    },
    nfd: "your-name.diiisco.algo",   // Optional — see Verified Identity below
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: ["sk-your-key"],
    port: 8080,
    networkWaitTime: 10000,          // How long to collect /network responses (ms)
  },
  quoteEngine: {
    waitTime: 1000,                  // How long to collect quotes before selecting (ms)
    quoteSelectionFunction: selectHighestStakeQuote,
    quoteCreationFunction: [createQuoteFromInputTokens],
    preferSelf: true,                // Serve locally when model is available, skipping the network
  },
  libp2pBootstrapServers: [
    "lon.diiisco.algo",
    "nyc.diiisco.algo",
  ],
  node: {
    url: "http://mynode.example.com",
    port: 4242,
    displayName: "My DIIISCO Node",
  },
};

export default environment;
```

### 🔒 Private network configuration

Remove the `algorand` block and add a `local` block. Each node still needs its own `peerIdStorage` path.

```typescript
const environment: Environment = {
  peerIdStorage: { path: "~/Desktop/" },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,
    apiKey: "",
    chargePer1MTokens: { default: 0.01703 }
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: ["sk-your-key"],
    port: 8080,
    networkWaitTime: 10000,
  },
  quoteEngine: {
    waitTime: 1000,
    quoteCreationFunction: [createQuoteFromInputTokens],
  },
  libp2pBootstrapServers: [
    "/ip4/192.168.1.10/tcp/4242/p2p/<peer-id-of-your-bootstrap-node>",
  ],
  node: {
    port: 4242,
    displayName: "My Private Node",
  },
  local: {
    enabled: true,
    privateTopic: "acme-corp/models/1.0.0",  // Unique name — isolates your cluster
  },
};
```

When `local.enabled` is `true`:
- 🔓 No Algorand wallet is required. Each node generates an ephemeral signing key at startup.
- 🆓 All inference is served freely. Payment contract steps are skipped entirely.
- 🔐 Only nodes sharing the same `privateTopic` can communicate.

For single-machine or LAN setups you can omit `libp2pBootstrapServers` entirely and rely on mDNS auto-discovery.

> ⚠️ **Use a unique `privateTopic`.** GossipSub subscription names are transmitted in plaintext over any shared connections. A descriptive, unique value (e.g. `acme-corp/models/1.0.0`) avoids accidental overlap with other networks. Do not use the public DIIISCO bootstrap servers on a private network.

---

## 📖 Configuration reference

### `peerIdStorage`

| Field | Description |
|---|---|
| `path` | Directory where `diiisco-peer-id.protobuf` is stored. This file is your node's persistent libp2p identity — back it up. |

### `models`

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Whether this node provides inference to the network |
| `baseURL` | `http://localhost` | Base URL of your LLM backend |
| `port` | `11434` | Port of your LLM backend (Ollama default) |
| `apiKey` | `""` | API key for the LLM backend, if required |
| `chargePer1MTokens` | — | USDC price per 1M tokens. `default` applies to all models; add per-model keys to override |

### `algorand` (public network only)

| Field | Description |
|---|---|
| `addr` | Your Algorand wallet address |
| `mnemonic` | Your 25-word mnemonic passphrase |
| `network` | `"mainnet"` or `"testnet"` |
| `client.address` | Algod API endpoint |
| `client.port` | Algod API port |
| `client.token` | Algod API token (empty for public nodes) |
| `nfd` | Optional `.diiisco.algo` NFD domain for verified on-chain identity |

On startup, the node automatically opts into the DSCO and USDC assets and registers with the DIIISCO smart contract if not already done. This requires a small ALGO balance for transaction fees and box storage.

### `api`

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Whether to start the HTTP API server |
| `bearerAuthentication` | `true` | Require `Authorization: Bearer <key>` on API requests |
| `keys` | `[]` | Accepted bearer tokens |
| `port` | `8080` | Port for the HTTP API |
| `networkWaitTime` | `10000` | How long (ms) the `/network` endpoint waits for peer responses before returning |

### `quoteEngine`

| Field | Default | Description |
|---|---|---|
| `waitTime` | `1000` | How long (ms) to collect quotes before selecting the best one |
| `quoteSelectionFunction` | `selectHighestStakeQuote` | Strategy used to choose among received quotes |
| `quoteCreationFunction` | `[createQuoteFromInputTokens]` | How the node prices its own quotes |
| `preferSelf` | `true` | If `true` and the requested model is available locally, serve it directly without broadcasting to the network |

**Quote selection strategies:**

- `selectHighestStakeQuote` — prefers providers with the most DSCO staked (default, public network)
- `selectFirstQuote` — takes the first quote received (default in local mode)

### `node`

| Field | Description |
|---|---|
| `url` | Publicly reachable URL of this node (used in log output) |
| `port` | TCP port for libp2p peer-to-peer connections (default: `4242`) |
| `displayName` | Human-readable name shown on the `/network` endpoint |

### `local`

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Disables Algorand payments and isolates the network to `privateTopic` |
| `privateTopic` | `diiisco/models/1.0.0` | GossipSub topic name. Must match across all nodes in the cluster |

### `libp2pBootstrapServers`

A list of known peers used to join the network on startup. Accepts multiaddrs directly (`/ip4/…/tcp/…/p2p/…`) or `.diiisco.algo` NFD names that resolve to a multiaddr. Leave empty on a LAN to use mDNS auto-discovery instead.

### 🪪 Verified identity with NFD

[NFD (Non-Fungible Domains)](https://app.nf.domains) is an Algorand naming service. Setting `algorand.nfd` to a `.diiisco.algo` subdomain links your node to a human-readable, on-chain identity that other nodes can verify. Your NFD record must contain a custom property `diiiscohost` set to your full libp2p multiaddr:

```
/dns4/mynode.example.com/tcp/4242/p2p/<your-peer-id>
```

If NFD verification fails at startup, the node operates normally — peers will see an unverified identity.

---

## 🚀 Running the node

**Development / one-off:**

```bash
npm run serve
```

Builds the project and starts the node in a single step.

**Production (PM2):**

```bash
npm run node:start    # Build and start as a background service
npm run node:status   # Check running status
npm run node:logs     # Tail recent logs
npm run node:monit    # Live resource monitor
npm run node:restart  # Rebuild and restart
npm run node:stop     # Stop the service
```

---

## 🔌 API reference

Every DIIISCO node exposes an OpenAI-compatible REST API. Point any OpenAI client or SDK at `http://your-node:8080` to use it as a drop-in backend.

When `api.bearerAuthentication` is `true`, all `/v1` and management endpoints require:

```
Authorization: Bearer <your-key>
```

### 🤖 Inference

#### `POST /v1/chat/completions`

Standard OpenAI chat completions endpoint. Accepts `messages` or `inputs`.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3:8b", "messages": [{"role": "user", "content": "Hello"}]}'
```

#### `GET /v1/models`

Returns a list of models available across the network.

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer sk-your-key"
```

### 🌍 Network

#### `GET /network`

Returns information about all reachable nodes. Waits `api.networkWaitTime` milliseconds for responses before returning.

```bash
curl http://localhost:8080/network \
  -H "Authorization: Bearer sk-your-key"
```

#### `GET /peers`

Returns the list of currently connected libp2p peers.

```bash
curl http://localhost:8080/peers \
  -H "Authorization: Bearer sk-your-key"
```

### 💚 Health

#### `GET /health`

Returns `200 API is healthy`. No authentication required. Suitable for load balancer health checks.

#### `GET /health/algorand`

Returns the Algorand wallet and contract registration status. Returns `200` when everything is healthy, `503` when the node is not ready to participate in paid inference.

```json
{
  "localMode": false,
  "address": "XXXX...",
  "appId": 3357935482,
  "algodReachable": true,
  "algoBalance": "13.269000 ALGO",
  "dsco": { "optedIn": true, "balance": "463414" },
  "usdc": { "optedIn": true, "balance": "2.940801 USDC" },
  "contractRegistered": true
}
```

A `503` with `contractRegistered: false` means the wallet hasn't registered with the DIIISCO smart contract — typically caused by insufficient ALGO balance at first startup.

---

## 🧩 Embedding DIIISCO in your application

The node can be imported as a library rather than run as a standalone process:

```typescript
import { Application, configureEnvironment } from 'diiisco-node';

configureEnvironment({
  models: { enabled: false },
  api: { port: 9090 },
});

const app = new Application();
await app.start();
```

Call `configureEnvironment` before constructing `Application`. Settings are deep-merged with the defaults in `environment.ts`.

---

<p align="center">
  <a href="https://diiisco.com">🌐 DIIISCO.com</a> &nbsp;·&nbsp;
  <a href="https://diiisco.com/docs/welcome">📖 Docs</a> &nbsp;·&nbsp;
  <a href="https://x.com/diiiscohq">𝕏 @diiiscohq</a> &nbsp;·&nbsp;
  <a href="https://discord.gg/WcuuVcrHFa">💬 Discord</a>
</p>
