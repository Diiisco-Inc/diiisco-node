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

When a request arrives at a DIIISCO node, it is broadcast to the network as a quote request that carries the requester's per-request budget (`maxSpend`) — but **not** the prompt itself. Nodes that can serve the model respond with their per-token price. The best quote is selected and the prompt is sent **directly to that one provider**, which runs inference (capped to what the budget affords), withholds the answer, and asks the requester to pay the actual metered cost via **x402**: a single signed USDC transfer, verified off-chain and settled on Algorand in ~3 seconds. The answer is released the moment payment is verified. Private clusters skip payment entirely and serve inference directly over the network.

Because the requester enforces its own `maxSpend` before signing, a node can never be charged more than the budget it set — no matter what a provider claims.

### Public network (payments enabled)

Nodes connect to the global DIIISCO network. Requesters pay providers in **USDC** per token actually used. Holding **DSCO** improves a provider's standing in quote selection (selection is stake-weighted by default). Requires an Algorand wallet on each node.

### Private network (payments disabled)

A cluster of nodes you control, isolated from the public network by a unique topic name. No Algorand wallets required — nodes generate an ephemeral signing key at startup. Useful for home labs, office clusters, or any situation where you want distributed inference without blockchain overhead.

---

## ⚡ Install the CLI

`diiisco` is a single self-contained executable. It embeds the node, so there is **no Node.js, npm or PM2 to install** — the binary manages its own background daemon and points agent tools at it.

**macOS and Linux:**

```bash
curl -fsSL https://diiisco.com/install.sh | sh
```

The installer detects your platform, downloads the matching release, **verifies its SHA-256** against the published `SHA256SUMS`, and installs to `~/.local/bin` — no `sudo`. If that directory isn't on your `PATH` it prints the exact `export PATH=…` line for your shell rather than editing your rc file behind your back.

```bash
# Pin a version, install system-wide, or let it edit your rc file:
curl -fsSL https://diiisco.com/install.sh | sh -s -- --version v1.1.0
curl -fsSL https://diiisco.com/install.sh | sh -s -- --system
curl -fsSL https://diiisco.com/install.sh | sh -s -- --modify-path
```

| Flag | Environment variable | Default |
|------|----------------------|---------|
| `--version VERSION` | `DIIISCO_VERSION` | latest release |
| `--install-dir DIR` | `DIIISCO_INSTALL_DIR` | `~/.local/bin` |
| `--system` | `DIIISCO_SYSTEM=1` | off (installs to `/usr/local/bin`) |
| `--modify-path` | `DIIISCO_MODIFY_PATH=1` | off |

**Windows:** download `diiisco-windows-x64.exe` from the [releases page](https://github.com/Diiisco-Inc/diiisco-node/releases/latest), or install [DIIISCO Desktop](https://diiisco.com), which ships the CLI and puts it on your `PATH`.

**Already have DIIISCO Desktop?** You already have `diiisco` — the app bundles it. `diiisco version` says which copy you're running (`[desktop-bundled]` is updated by the app, `[standalone]` by re-running the installer).

### First run

There is **no zero-config run**: a useful node needs an inference backend, an API key, and — on the public network — a wallet. Two commands:

```bash
diiisco setup          # interactive wizard; writes ~/.diiisco/diiisco.config.json (0600)
diiisco launch claude  # starts a node if one isn't running, then opens Claude Code against it
```

`setup` is scriptable too:

```bash
diiisco setup --local --yes                                        # payment-free node, all defaults
diiisco setup --public --yes --network testnet --mnemonic-stdin < wallet.txt
diiisco setup --print                                              # emit the JSON, write nothing
```

A mnemonic is only ever read from stdin or an echo-off prompt — never from `argv`.

### Command surface

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
  config show|path|edit  Inspect or edit the config file
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

Flags: `--endpoint URL` (or `--remote`, attach to a node you already have), `--key KEY`, `--model MODEL`, `--no-spawn`, `--list [--json]`. Anything after the app name is passed straight through: `diiisco launch claude --resume`.

Add your own targets without waiting for a release, via the `cli.apps` block in the config file:

```json
{ "cli": { "apps": { "aider": { "bin": "aider", "wire": "openai" } } } }
```

Everything the CLI writes lives under `~/.diiisco/` (override with `DIIISCO_HOME`):

```
~/.diiisco/
  diiisco.config.json       your config, mode 0600
  diiisco-peer-id.protobuf  this node's identity
  daemon.json               pid / state file
  logs/diiisco.log          daemon log, rotated at 10 MB
```

Exit codes: `0` success, `1` failure, **`2` not configured** — so a script can tell "run `diiisco setup`" apart from a real error.

---

## 📋 Requirements

- **An LLM runtime** — [Ollama](https://ollama.com/) or any OpenAI-compatible backend (e.g. [Shimmy](https://github.com/Michael-A-Kuykendall/shimmy))
- **An Algorand wallet** — required for the public network only (we recommend [Pera Wallet](https://perawallet.app/))
- **Node.js 22** — only for the source checkout below; the `diiisco` binary needs no runtime

> ⚠️ **Never share your mnemonic.** Never enter it on a device you don't control.

---

## 📦 Running from source

The CLI covers everyday use. Clone the repo when you want to modify the node itself:

```bash
git clone https://github.com/Diiisco-Inc/diiisco-node.git
cd diiisco-node
bun install     # or: npm install
```

The repo runs on [Bun](https://bun.sh); `bun.lock` is committed alongside `package-lock.json` during the transition, and the Node 22 build (`dist/index.js`) is still what library consumers import.

```bash
bun run dev                 # run the node from source with your local environment.ts
bun run cli -- status       # run the CLI from source
bun test                    # the smoke suite
bun run build:web           # rebuild the status pages + their embedded manifest
bun run build:binaries      # compile dist/bin/diiisco-<os>-<arch>
```

### Status pages in the binary

The public status pages (`/`, `/nodes`, `/nodes/{peerId}`) are served from
`src/api/webManifest.generated.json`, a committed manifest of the `web/` build.
It exists because Bun's standalone filesystem has embedded *files* but no
directories, so a compiled binary cannot mount `dist/web` — it would serve an
`index.html` whose hashed JS and CSS 404.

**After changing anything under `web/`, run `npm run build:web` and commit the
regenerated manifest with your change.** A source checkout or a `tsup` build
still serves `dist/web` straight off disk when it exists, so the manifest only
matters for the compiled binary; `node scripts/build-web-manifest.mjs --check`
reports whether it is stale, and CI runs that on every release.

### Releases and the desktop app

A `v*` tag runs `.github/workflows/release.yml`, which refuses to publish unless
`package.json` (and `src/cli/version.ts`'s `FALLBACK_VERSION`) match the tag —
DIIISCO Desktop bundles the CLI of the same tag and reports both versions, so
the two must never drift.

Each release carries both variants of the executables:

| Asset | Variant | Consumer |
|---|---|---|
| `diiisco-<os>-<arch>[.exe]`, `SHA256SUMS` | `standalone` | `install.sh`, direct download |
| `diiisco-desktop-<os>-<arch>[.exe]`, `SHA256SUMS.desktop` | `desktop-bundled` | the [diiisco-desktop](https://github.com/Diiisco-Inc/diiisco-desktop) build |
| `diiisco-desktop-bundled.zip` | `desktop-bundled` | the same binaries under their canonical `diiisco-<os>-<arch>` names |

The desktop repo consumes the **desktop-bundled** assets of the **same tag** and
points its bundling step at them with `DIIISCO_CLI_ARTIFACTS`:

```bash
gh release download "$TAG" --repo Diiisco-Inc/diiisco-node \
  --pattern 'diiisco-desktop-bundled.zip' --dir /tmp
unzip -d dist/cli /tmp/diiisco-desktop-bundled.zip
DIIISCO_CLI_ARTIFACTS="$PWD/dist/cli" bun run build
```

The two variants differ only in the `DIIISCO_INSTALL_SOURCE` baked into them,
which decides whether `diiisco version` and the update hint point at the desktop
updater or at `install.sh`. They are deliberately *not* interchangeable — never
download them with a `diiisco-*` glob, which also matches the standalone assets,
and assert `diiisco version | grep '\[desktop-bundled\]'` after copying.

---

## ⚙️ Configuration

There are two places a node reads its configuration from, with the **same shape** in both:

| | File | Written by |
|---|---|---|
| **CLI / desktop app** | `~/.diiisco/diiisco.config.json` (JSON, mode `0600`) | `diiisco setup`, `diiisco config edit` |
| **Source checkout** | `src/environment/environment.ts` (TypeScript, gitignored) | you |

Every key documented below is valid in both. The JSON file takes **strategy names** where the TypeScript interface takes functions — `"quoteSelectionFunction": "selectHighestStakeQuote"` — and they are resolved on load. Anything you leave out falls back to the committed defaults in `src/environment/defaults.ts`.

Resolution order for the JSON file: `--config <path>`, then `$DIIISCO_CONFIG`, then `$DIIISCO_HOME/diiisco.config.json`, then `~/.diiisco/diiisco.config.json`.

For a source checkout, copy the example configuration and edit it:

```bash
cp src/environment/example.environment.ts src/environment/environment.ts
```

### 🌐 Public network configuration

```typescript
import { Environment } from "./environment.types";
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";

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
      // Price per 1M tokens in USDC. A bare number sets equal input/output
      // rates; use { input, output } to price them separately.
      default: 0.01703,
      "llama3:8b": { input: 0.01, output: 0.03 },  // Per-model split-rate override
    }
  },
  algorand: {
    mnemonic: "YOUR_25_WORD_MNEMONIC",   // The wallet address is derived from this
    network: "mainnet",
    client: {
      address: "https://mainnet-api.algonode.cloud/",
      port: 443,
      token: ""
    },
    nfd: "your-name.diiisco.algo",       // Optional — see Verified Identity below
    settlement: {
      methods: ["x402"],                 // Settlement method (x402 is the only one)
      maxSpend: 0.01,                    // USDC — most you'll pay per request; unset = won't pay
      x402: {
        facilitatorUrl: "https://facilitator.goplausible.xyz/",
        selfSubmitFallback: true,        // Submit to algod directly if the facilitator is down
      },
    },
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
- 🆓 All inference is served freely. Quoting and x402 settlement are skipped entirely.
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
| `chargePer1MTokens` | — | USDC price per 1M tokens. A bare number sets equal input/output rates; use `{ input, output }` to price them separately. `default` applies to all models; add per-model keys to override. |

### `algorand` (public network only)

| Field | Description |
|---|---|
| `mnemonic` | Your 25-word mnemonic passphrase — the wallet address is derived from this |
| `network` | `"mainnet"` or `"testnet"` — selects the USDC ASA and CAIP-2 id used for settlement |
| `client.address` | Algod API endpoint |
| `client.port` | Algod API port |
| `client.token` | Algod API token (empty for public nodes) |
| `nfd` | Optional `.diiisco.algo` NFD domain for verified on-chain identity |
| `settlement` | x402 settlement config — see below |

On startup, the node automatically opts into the DSCO and USDC assets if not already done. This requires a small ALGO balance for the opt-in and for x402 transaction fees.

### `algorand.settlement`

| Field | Default | Description |
|---|---|---|
| `methods` | `["x402"]` | Accepted/offered settlement methods, preference-ordered. x402 is currently the only method. |
| `maxSpend` | — | **Per-request spending limit in USDC.** As a requester, the node never signs a payment above this (and refuses to pay at all if unset) — so it can't be overcharged. As a provider, it's the budget requesters send you to size their quote and generation. |
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
| `quoteSelectionFunction` | `selectHighestStakeQuote` | Strategy (or list of strategies, tried in order) used to choose among received quotes |
| `quoteCreationFunction` | `createStandardQuote` | Optional override for how the node prices its own quotes — supply a function with the same signature for dynamic/surge pricing. Defaults to per-token rates from `chargePer1MTokens`. |
| `preferSelf` | `true` | If `true` and the requested model is available locally, serve it directly without broadcasting to the network |

**Quote selection strategies:**

- `selectHighestStakeQuote` — prefers providers holding the most DSCO, breaking ties on verified NFD then response speed (default)
- `selectCheapestQuote` — prefers the lowest combined per-token rate
- `selectFastestQuote` — prefers the provider that responded quickest

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

### `cli`

Optional. Read by the `diiisco` binary (and by DIIISCO Desktop's Launch view, which renders one button per entry).

| Field | Description |
|---|---|
| `apps` | Extra `diiisco launch` targets, keyed by app name: `{ "bin": "aider", "wire": "openai", "installHint": "…", "args": [] }`. Overrides a built-in target of the same name. `wire` is `"anthropic"` or `"openai"`. |
| `terminal` | Overrides the terminal DIIISCO Desktop opens for a launch button. |

```json
{ "cli": { "apps": { "aider": { "bin": "aider", "wire": "openai" } } } }
```

### 🪪 Verified identity with NFD

[NFD (Non-Fungible Domains)](https://app.nf.domains) is an Algorand naming service. Setting `algorand.nfd` to a `.diiisco.algo` subdomain links your node to a human-readable, on-chain identity that other nodes can verify. Your NFD record must contain a custom property `diiiscohost` set to your full libp2p multiaddr:

```
/dns4/mynode.example.com/tcp/4242/p2p/<your-peer-id>
```

If NFD verification fails at startup, the node operates normally — peers will see an unverified identity.

---

## 🚀 Running the node

**With the CLI** (no build step, no process manager):

```bash
diiisco start     # start as a background daemon
diiisco status    # pid, uptime, health, Algorand summary
diiisco logs -f   # follow the log
diiisco stop      # stop
diiisco serve     # or run it in the foreground
```

**From a source checkout, development / one-off:**

```bash
npm run serve
```

Builds the project and starts `dist/dev.js`, which applies your local `src/environment/environment.ts` when you have one.

**From a source checkout, production (PM2):**

```bash
npm run node:start    # Build and start as a background service
npm run node:status   # Check running status
npm run node:logs     # Tail recent logs
npm run node:monit    # Live resource monitor
npm run node:restart  # Rebuild and restart
npm run node:stop     # Stop the service
```

PM2 remains supported for the repo workflow; the `diiisco` binary never uses it.

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

Returns the Algorand wallet status. Returns `200` when the node is ready to participate in paid inference (algod reachable and the wallet opted into USDC), `503` otherwise.

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

A `503` means algod is unreachable or the wallet hasn't opted into USDC — typically caused by insufficient ALGO balance to complete the opt-in at first startup.

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
