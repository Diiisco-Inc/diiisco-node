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

DIIISCO is open-source and free forever. Any application that calls an OpenAI-compatible API can be used with DIIISCO.

---

## ⚡ Quickstart

Install the CLI. It is a single self-contained executable that embeds the node, so there is no Node.js, npm or PM2 to install.

**macOS and Linux**

```bash
curl -fsSL https://diiis.co/install.sh | sudo sh
```

**Windows**

```powershell
irm https://diiis.co/install.ps1 | iex
```

Then configure a node and point an agent at it:

```bash
diiisco setup          # interactive wizard, writes ~/.diiisco/diiisco.config.json
diiisco launch claude  # starts a node if one isn't running, then opens Claude Code against it
```

There is no zero-config run. A useful node needs an inference backend, an API key, and on the public network a wallet, so `diiisco setup` comes first.

**You will also need:**

- An LLM runtime: [Ollama](https://ollama.com/) or any OpenAI-compatible backend such as [Shimmy](https://github.com/Michael-A-Kuykendall/shimmy).
- An Algorand wallet, for the public network only. We recommend [Pera Wallet](https://perawallet.app/).

<details>
<summary><b>Installer details and options</b></summary>

<br />

Both installers detect your platform, download the matching release, and verify its SHA-256 against the published `SHA256SUMS`.

**macOS and Linux** install to `/usr/local/bin`, which is already on `PATH` everywhere, so the default needs `sudo`. The script never calls `sudo` on your behalf: if the destination needs elevation it prints the command to run. Pass `--user` to install to `~/.local/bin` with no `sudo` at all, and `--modify-path` if you want your shell rc file updated. Otherwise it just prints the `export PATH=...` line for you to add.

On **macOS** this installs [DIIISCO Desktop](https://diiis.co) as well by default, copying `DIIISCO.app` into `/Applications`. Pass `--no-desktop` for the CLI alone. There is no Linux desktop build, so on Linux you always get just the CLI.

```bash
curl -fsSL https://diiis.co/install.sh | sh -s -- --user --no-desktop
```

**Windows** installs `diiisco.exe` to `%LOCALAPPDATA%\DIIISCO\bin`, so no Administrator rights are needed. Windows has no conventional user `bin` directory already on `PATH`, so the installer adds it to your **user** `PATH` in the registry. Pass `-NoModifyPath` to skip that. It also installs [DIIISCO Desktop](https://diiis.co) by default; pass `-NoDesktop` for the CLI alone.

`iex` cannot forward arguments, so pass flags through a script block, or use the environment variables:

```powershell
& ([scriptblock]::Create((irm https://diiis.co/install.ps1))) -NoDesktop
```

**Already have DIIISCO Desktop?** You already have `diiisco`, because the app bundles it. `diiisco version` says which copy you are running: `[desktop-bundled]` is updated by the app, `[standalone]` by re-running the installer.

</details>

---

## 🪩 How DIIISCO works

1. A request arrives at your node and is broadcast to the network as a quote request carrying your per-request budget (`maxSpend`). The prompt itself is **not** broadcast.
2. Nodes that can serve the model reply with their per-token price.
3. The best quote is selected and the prompt is sent **directly to that one provider**.
4. The provider runs inference, capped to what the budget affords, withholds the answer, and asks for the actual metered cost via **x402**: a single signed USDC transfer, verified off-chain and settled on Algorand in around 3 seconds.
5. The answer is released the moment payment is verified.

Your node enforces its own `maxSpend` before signing, so it can never be charged more than the budget you set, no matter what a provider claims.

### Public network (payments enabled)

Nodes connect to the global DIIISCO network. Requesters pay providers in **USDC** per token actually used. Holding **DSCO** improves a provider's standing in quote selection, which is stake-weighted by default. Requires an Algorand wallet on each node.

### Private network (payments disabled)

A cluster of nodes you control, isolated from the public network by a unique topic name. No Algorand wallets required, because nodes generate an ephemeral signing key at startup. Useful for home labs, office clusters, or any situation where you want distributed inference without blockchain overhead.

---

## 🎛 Everyday commands

```
diiisco <command> [flags]

  setup                  Create or edit the config file (start here)
  start                  Start the node as a background daemon
  stop                   Stop the background daemon
  restart                Restart the daemon
  status [--json]        pid, uptime, /health and an Algorand summary
  logs [-f] [-n N]       Show (or follow) the daemon log
  serve                  Run the node in the foreground (Ctrl-C to stop)
  launch <app> [flags]   Point an agent tool at a node, starting one if needed
  config show|path|edit  Inspect or edit the config file (`path --key` for the wallet key)
  version                Print version, commit and install source
  help                   Print usage
```

`diiisco launch` wires the agent's environment to your node and hands over:

| App | Binary | Wire protocol |
|-----|--------|---------------|
| `claude` | `claude` | Anthropic (`/v1/messages`) |
| `openclaw` | `openclaw` | Anthropic |
| `codex` | `codex` | OpenAI (`/v1/chat/completions`) |
| `opencode` | `opencode` | OpenAI |
| `hermes` | `hermes` | OpenAI |

Flags: `--endpoint URL` (or `--remote`, to attach to a node you already have), `--key KEY`, `--model MODEL`, `--no-spawn`, `--list [--json]`. Anything after the app name is passed straight through: `diiisco launch claude --resume`.

Exit codes: `0` success, `1` failure, `2` not configured, so a script can tell "run `diiisco setup`" apart from a real error.

### Where things live

Everything the CLI writes lives under `~/.diiisco/`, which `DIIISCO_HOME` overrides:

```
~/.diiisco/
  diiisco.config.json       your config, mode 0600
  algorand-key.json         your wallet key, mode 0600, back this up
  diiisco-peer-id.protobuf  this node's identity
  daemon.json               pid / state file
  logs/diiisco.log          daemon log, rotated at 10 MB
```

The wallet key is kept **out** of the config file on purpose. The config is the file you hand-edit, paste into an issue and copy between machines, and those 25 words are full spending authority over the account. `diiisco config path --key` prints where it lives.

> ⚠️ **Never share your mnemonic.** Never enter it on a device you don't control.
> The CLI keeps it in `~/.diiisco/algorand-key.json` (mode `0600`) and nowhere
> else. Back that file up, and treat it the way you would a private key.

---

## ⚙️ Configuration

`diiisco setup` writes `~/.diiisco/diiisco.config.json` for you, and `diiisco config edit` reopens it. The file is plain JSON and safe to hand-edit. Anything you leave out falls back to the committed defaults in `src/environment/defaults.ts`.

Resolution order: `--config <path>`, then `$DIIISCO_CONFIG`, then `$DIIISCO_HOME/diiisco.config.json`, then `~/.diiisco/diiisco.config.json`.

The wallet mnemonic is the one thing that does **not** go in this file. It lives on its own in `algorand-key.json` beside it.

### 🌐 Public network

The comments below are for reading only. `diiisco.config.json` is parsed as strict JSON, so strip them if you copy this.

```jsonc
{
  "peerIdStorage": { "path": "~/.diiisco" },
  "models": {
    "enabled": true,
    "baseURL": "http://localhost",
    "port": 11434,                    // Default Ollama port
    "apiKey": "",                     // Usually not needed for local LLMs
    "chargePer1MTokens": {
      // Price per 1M tokens in USDC. A bare number sets equal input/output
      // rates; use { input, output } to price them separately.
      "default": 0.01703,
      "llama3:8b": { "input": 0.01, "output": 0.03 }
    }
  },
  "algorand": {
    "network": "mainnet",
    "client": {
      "address": "https://mainnet-api.algonode.cloud/",
      "port": 443,
      "token": ""
    },
    "nfd": "your-name.diiisco.algo",  // Optional, see Verified identity below
    "settlement": {
      "methods": ["x402"],
      "maxSpend": 0.01,               // USDC, most you'll pay per request. Unset means won't pay
      "x402": {
        "facilitatorUrl": "https://facilitator.goplausible.xyz/",
        "selfSubmitFallback": true    // Submit to algod directly if the facilitator is down
      }
    }
  },
  "api": {
    "enabled": true,
    "bearerAuthentication": true,
    "keys": ["sk-your-key"],
    "port": 8080,
    "networkWaitTime": 10000          // How long to collect /network responses (ms)
  },
  "quoteEngine": {
    "waitTime": 1000,                 // How long to collect quotes before selecting (ms)
    "quoteSelectionFunction": "selectHighestStakeQuote",
    "preferSelf": true                // Serve locally when the model is available
  },
  "libp2pBootstrapServers": ["lon.diiisco.algo", "nyc.diiisco.algo"],
  "node": {
    "url": "http://mynode.example.com",
    "port": 4242,
    "displayName": "My DIIISCO Node"
  }
}
```

### 🔒 Private network

Remove the `algorand` block and add a `local` block. Everything else stays the same, and each node still needs its own `peerIdStorage` path.

```jsonc
{
  "libp2pBootstrapServers": [
    "/ip4/192.168.1.10/tcp/4242/p2p/<peer-id-of-your-bootstrap-node>"
  ],
  "local": {
    "enabled": true,
    "privateTopic": "acme-corp/models/1.0.0"  // Unique name, isolates your cluster
  }
}
```

When `local.enabled` is `true`:

- 🔓 No Algorand wallet is required. Each node generates an ephemeral signing key at startup.
- 🆓 All inference is served freely. Quoting and x402 settlement are skipped entirely.
- 🔐 Only nodes sharing the same `privateTopic` can communicate.

For single-machine or LAN setups you can omit `libp2pBootstrapServers` entirely and rely on mDNS auto-discovery.

> ⚠️ **Use a unique `privateTopic`.** GossipSub subscription names are transmitted in plaintext over any shared connections. A descriptive, unique value such as `acme-corp/models/1.0.0` avoids accidental overlap with other networks. Do not use the public DIIISCO bootstrap servers on a private network.

---

## 📖 Configuration reference

### `peerIdStorage`

| Field | Description |
|---|---|
| `path` | Directory where `diiisco-peer-id.protobuf` is stored. This file is your node's persistent libp2p identity, so back it up. |

### `models`

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Whether this node provides inference to the network |
| `baseURL` | `http://localhost` | Base URL of your LLM backend |
| `port` | `11434` | Port of your LLM backend (Ollama default) |
| `apiKey` | `""` | API key for the LLM backend, if required |
| `chargePer1MTokens` | (none) | USDC price per 1M tokens. A bare number sets equal input/output rates; use `{ input, output }` to price them separately. `default` applies to all models; add per-model keys to override. |

### `algorand` (public network only)

| Field | Description |
|---|---|
| `mnemonic` | Your 25-word mnemonic passphrase, from which the wallet address is derived. **On the CLI and desktop path this belongs in `~/.diiisco/algorand-key.json`, not here.** A copy left in the config is moved there on the next `diiisco start`. Source checkouts still set it in `src/environment/environment.ts`. |
| `network` | `"mainnet"` or `"testnet"`. Selects the USDC ASA and CAIP-2 id used for settlement. |
| `client.address` | Algod API endpoint |
| `client.port` | Algod API port |
| `client.token` | Algod API token (empty for public nodes) |
| `nfd` | Optional `.diiisco.algo` NFD domain for verified on-chain identity |
| `settlement` | x402 settlement config, see below |

On startup, the node automatically opts into the DSCO and USDC assets if not already done. This requires a small ALGO balance for the opt-in and for x402 transaction fees.

### `algorand.settlement`

| Field | Default | Description |
|---|---|---|
| `methods` | `["x402"]` | Accepted and offered settlement methods, preference-ordered. x402 is currently the only method. |
| `maxSpend` | (none) | **Per-request spending limit in USDC.** As a requester, the node never signs a payment above this, and refuses to pay at all if unset, so it cannot be overcharged. As a provider, it is the budget requesters send you to size their quote and generation. |
| `x402.facilitatorUrl` | GoPlausible | URL of the x402 facilitator that verifies and submits payments |
| `x402.selfSubmitFallback` | `true` | If the facilitator is unreachable, submit the signed payment group directly to algod |

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
| `quoteSelectionFunction` | `selectHighestStakeQuote` | Strategy, or list of strategies tried in order, used to choose among received quotes |
| `quoteCreationFunction` | `createStandardQuote` | Optional override for how the node prices its own quotes. Supply a function with the same signature for dynamic or surge pricing. Defaults to per-token rates from `chargePer1MTokens`. |
| `preferSelf` | `true` | If `true` and the requested model is available locally, serve it directly without broadcasting to the network |

**Quote selection strategies:**

- `selectHighestStakeQuote` prefers providers holding the most DSCO, breaking ties on verified NFD then response speed (default)
- `selectCheapestQuote` prefers the lowest combined per-token rate
- `selectFastestQuote` prefers the provider that responded quickest

### `node`

| Field | Description |
|---|---|
| `url` | Publicly reachable URL of this node (used in log output) |
| `port` | TCP port for libp2p peer-to-peer connections (default `4242`) |
| `displayName` | Human-readable name shown on the `/network` endpoint |

### `local`

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Disables Algorand payments and isolates the network to `privateTopic` |
| `privateTopic` | `diiisco/models/1.0.0` | GossipSub topic name. Must match across all nodes in the cluster. |

### `libp2pBootstrapServers`

A list of known peers used to join the network on startup. Accepts multiaddrs directly (`/ip4/.../tcp/.../p2p/...`) or `.diiisco.algo` NFD names that resolve to a multiaddr. Leave empty on a LAN to use mDNS auto-discovery instead.

### `cli`

Optional. Read by the `diiisco` binary, and by DIIISCO Desktop's Launch view, which renders one button per entry.

| Field | Description |
|---|---|
| `apps` | Extra `diiisco launch` targets, keyed by app name: `{ "bin": "aider", "wire": "openai", "installHint": "...", "args": [] }`. Overrides a built-in target of the same name. `wire` is `"anthropic"` or `"openai"`. |
| `terminal` | Overrides the terminal DIIISCO Desktop opens for a launch button. |

```json
{ "cli": { "apps": { "aider": { "bin": "aider", "wire": "openai" } } } }
```

### 🪪 Verified identity with NFD

[NFD (Non-Fungible Domains)](https://app.nf.domains) is an Algorand naming service. Setting `algorand.nfd` to a `.diiisco.algo` subdomain links your node to a human-readable, on-chain identity that other nodes can verify. Your NFD record must contain a custom property `diiiscohost` set to your full libp2p multiaddr:

```
/dns4/mynode.example.com/tcp/4242/p2p/<your-peer-id>
```

If NFD verification fails at startup, the node operates normally and peers will see an unverified identity.

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

#### `POST /v1/messages`

Anthropic Messages API. This is what `diiisco launch claude` points Claude Code at, and what any Anthropic SDK client will use. Requests are translated to the internal OpenAI shape and back, so the same network auction and settlement applies.

```bash
curl http://localhost:8080/v1/messages \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3:8b", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

`max_tokens` is required. `system`, `temperature`, `top_p` and `tools` are forwarded, with tool definitions mapped between `input_schema` and `parameters`, and `tool_use` and `tool_result` blocks translated in both directions.

Set `stream: true` and the response comes back as SSE. Note that the node does not generate incrementally anywhere: the completed answer is re-framed as a batched stream, one delta per content block. Image blocks and extended thinking blocks are accepted and ignored.

#### `POST /v1/messages/count_tokens`

Returns `{ "input_tokens": N }` for a request body in the same shape as `/v1/messages`, minus `max_tokens`. Counting happens against this node's local model backend, so a node with no backend configured returns `503`.

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

Returns the Algorand wallet status. Returns `200` when the node is ready to participate in paid inference, meaning algod is reachable and the wallet is opted into USDC, and `503` otherwise.

```json
{
  "localMode": false,
  "address": "XXXX...",
  "algodReachable": true,
  "algoBalance": "13.269000 ALGO",
  "dsco": { "optedIn": true, "balance": "463414" },
  "usdc": { "optedIn": true, "balance": "2.940801 USDC" }
}
```

A `503` means algod is unreachable or the wallet has not opted into USDC, typically caused by insufficient ALGO balance to complete the opt-in at first startup.

---

## 📦 Running from source

The CLI covers everyday use. Clone the repo when you want to modify the node itself. This is also the only path that needs **Node.js 22**; the `diiisco` binary needs no runtime.

```bash
git clone https://github.com/Diiisco-Inc/diiisco-node.git
cd diiisco-node
bun install     # or: npm install
```

The repo runs on [Bun](https://bun.sh). `bun.lock` is committed alongside `package-lock.json` during the transition, and the Node 22 build (`dist/index.js`) is still what library consumers import.

```bash
bun run dev                 # run the node from source with your local environment.ts
bun run cli -- status       # run the CLI from source
bun test                    # the smoke suite
bun run build:web           # rebuild the status pages and their embedded manifest
bun run build:binaries      # compile dist/bin/diiisco-<os>-<arch>
```

### Configuring a source checkout

A source checkout reads a gitignored TypeScript file instead of the JSON config. Copy the example and edit it:

```bash
cp src/environment/example.environment.ts src/environment/environment.ts
```

The shape is identical to `diiisco.config.json`, with two differences:

- The strategy hooks take **real functions** rather than names, so `quoteSelectionFunction: selectHighestStakeQuote` instead of `"selectHighestStakeQuote"`. This is how you supply a custom pricing or selection function.
- The `mnemonic` stays inline in `algorand`, because a source checkout does not use `algorand-key.json`.

```typescript
import { Environment } from "./environment.types";
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";

const environment: Environment = {
  // ...same keys as the JSON above...
  algorand: { mnemonic: "your twenty five word mnemonic ...", /* ... */ },
  quoteEngine: { waitTime: 1000, quoteSelectionFunction: selectHighestStakeQuote },
};

export default environment;
```

### Running it

```bash
npm run serve         # build, then start dist/dev.js in the foreground
```

`dist/dev.js` applies your local `src/environment/environment.ts` when you have one.

For a long-running node from a source checkout, PM2 is still supported. The `diiisco` binary never uses it.

```bash
npm run node:start    # Build and start as a background service
npm run node:status   # Check running status
npm run node:logs     # Tail recent logs
npm run node:monit    # Live resource monitor
npm run node:restart  # Rebuild and restart
npm run node:stop     # Stop the service
```

### Embedding DIIISCO in your application

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

Call `configureEnvironment` before constructing `Application`. Settings are deep-merged with the defaults in `src/environment/defaults.ts`.

---

<p align="center">
  <a href="https://diiisco.com">🌐 DIIISCO.com</a> &nbsp;·&nbsp;
  <a href="https://diiisco.com/docs/welcome">📖 Docs</a> &nbsp;·&nbsp;
  <a href="https://x.com/diiiscohq">𝕏 @diiiscohq</a> &nbsp;·&nbsp;
  <a href="https://discord.gg/WcuuVcrHFa">💬 Discord</a>
</p>
