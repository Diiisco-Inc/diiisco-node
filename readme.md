<img src="https://github.com/Diiisco-Inc/diiisco-node/blob/main/assets/diiisco-logo.png?raw=true" width="1000" />

Diiisco is a globally distributed peer-to-peer network for running large language models. Send a prompt to any node on the network and receive a response from the model of your choice. Contributors earn Algorand for providing compute power.

## 👋 Join the Network

Joining the network is easy. You'll need:

- **Node.js 22** or higher
- **A local LLM runtime** such as [Ollama](https://ollama.com/) or [Shimmy](https://github.com/Michael-A-Kuykendall/shimmy)
- **An Algorand wallet** for receiving payments (we recommend [Pera Wallet](https://perawallet.app/))

### 🦙 Run Your Own Large Language Model

Download and install [Ollama](https://ollama.com/) or follow the [Shimmy installation guide](https://github.com/Michael-A-Kuykendall/shimmy). Once installed, download a model appropriate for your hardware:

- **Laptops**: Small models (7B parameters or less)
- **Desktop PCs**: Medium models (13B-30B parameters)
- **Gaming PCs / GPUs**: Large models (30B+ parameters)

### 💰 Get Setup with Algorand

Download [Pera Wallet](https://perawallet.app/) on iOS or Android. You'll need your wallet address and 25-word mnemonic passphrase.

> **Warning**: Never share or enter your mnemonic on a device you don't control. Keep it secret, keep it safe.

### 📦 Download and Install Diiisco Node

```bash
git clone https://github.com/Diiisco-Inc/diiisco-node.git
cd diiisco-node
npm install
```

### 🌍 Set Your Environment

Copy the example environment file and edit it with your settings:

```bash
cp src/environment/example.environment.ts src/environment/environment.ts
```

Edit `src/environment/environment.ts` with your configuration:

```typescript
const environment: Environment = {
  peerIdStorage: {
    path: "~/Desktop/"                      // Where to store your peer identity
  },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,                            // Default Ollama port
    apiKey: "",                             // Usually not needed for local LLMs
    chargePer1MTokens: {
      default: 0.001,                       // Price per 1M tokens in USDC
      "gpt-oss:20b": 0.002,                 // Per-model override
    }
  },
  algorand: {
    addr: "YOUR_ALGORAND_ADDRESS_HERE",
    mnemonic: "YOUR_ALGORAND_MNEMONIC_HERE",
    network: "mainnet",
    client: {
      address: "https://mainnet-api.algonode.cloud/",
      port: 443,
      token: ""
    },
    nfd: "your-name.diiisco.algo",          // Optional: NFD domain for verified identity
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: [
      "sk-your-api-key-1",
      "sk-your-api-key-2"
    ],
    port: 8080
  },
  quoteEngine: {
    waitTime: 1000,
    quoteSelectionFunction: selectHighestStakeQuote,
    quoteCreationFunction: [createQuoteFromInputTokens],
    preferSelf: false,                      // Set true to serve requests locally instead of earning DSCO
  },
  libp2pBootstrapServers: [
    "lon.diiisco.algo",
    "nyc.diiisco.algo",
  ],
  node: {
    url: "http://localhost",
    port: 4242,                             // Port for node-to-node communication
    displayName: "My Diiisco Node",
  },
}
```

#### `algorand.nfd`: NFD Domain (optional)

[NFD (Non-Fungible Domain)](https://app.nf.domains/name/diiisco.algo?view=segments) is an Algorand naming service. Setting this field links your node to a human-readable `.diiisco.algo` domain, providing a verified on-chain identity that other nodes on the network can trust. Your NFD record must have a custom property `diiiscohost` set to your node's full libp2p multiaddr (e.g. `/dns4/mynode.example.com/tcp/4242/p2p/<your-peer-id>`)

If the NFD check fails at startup, your node will still operate normally but peers will simply see an unverified identity.

#### `quoteEngine.preferSelf`: Local-First Inference (default: `true`)

When `preferSelf` is `true`, a node will serve a request directly from its own model if the requested model is available locally, without broadcasting a quote request to the network. This eliminates network round-trip latency.

### 🚀 You're Ready to Go

For development or testing, build and run with:

```bash
npm run serve
```

This command builds the project and starts the node in a single step.

### 🖥️ Production Deployment

For running your node as a background service, use the PM2 commands:

```bash
# Start the node
npm run node:start

# Check status
npm run node:status

# View logs
npm run node:logs

# Monitor in real-time
npm run node:monit

# Restart the node
npm run node:restart

# Stop the node
npm run node:stop
```

## ❤️ Love Diiisco, Use Diiisco

Every Diiisco node exposes REST API endpoints compatible with the OpenAI API standard. This means you can use Diiisco as a drop-in replacement in any codebase that uses the OpenAI API or SDK.

Point your OpenAI client to your node's API endpoint (default: `http://localhost:8080`) and use one of your configured API keys for authentication.

Diiisco is open-source and free forever.

## 🏠 Running a Private Network

You can run Diiisco on a private network, for example, across machines you own in a home lab, office, or cloud environment, without any Algorand payments. In this mode, all nodes serve inference requests freely to any peer on the network.

### Setting up a private network

On each node, configure the `local` block and remove the `algorand` block entirely:

```typescript
const environment: Environment = {
  peerIdStorage: {
    path: "~/Desktop/"
  },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,
    apiKey: "",
    chargePer1MTokens: {
      default: 0.001,
    }
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: ["sk-your-api-key"],
    port: 8080
  },
  quoteEngine: {
    waitTime: 1000,
    quoteCreationFunction: [createQuoteFromInputTokens],
  },
  libp2pBootstrapServers: [
    "/ip4/192.168.1.10/tcp/4242/p2p/<peer-id>",  // your own bootstrap node
  ],
  node: {
    url: "http://localhost",
    port: 4242,
    displayName: "My Private Node",
  },
  local: {
    enabled: true,
    privateTopic: "my-org/models/1.0.0"           // unique name for your network
  },
}
```

When `local.enabled` is `true`:

- **No Algorand wallet is required.** Each node generates an ephemeral keypair at startup used only for P2P message signing.
- **All inference requests are served freely.** Payment contract steps are skipped entirely.
- **The network is isolated by topic.** Only nodes sharing the same `privateTopic` value can communicate with each other.

> **Choose a unique `privateTopic`** for your deployment. A descriptive name (e.g. `"acme-corp/models/1.0.0"`) avoids accidental collisions with other private networks.

### Bootstrap servers on a private network

Use your own bootstrap server rather than the public Diiisco ones. You can run any Diiisco node as a bootstrap server, just take note of its multiaddr from the startup log and add it to `libp2pBootstrapServers` on your other nodes. For a single local LAN, you can leave `libp2pBootstrapServers` empty and rely on mDNS discovery instead.

> **Do not use the public Diiisco bootstrap servers on a private network.** GossipSub subscription announcements are transmitted in plaintext, which means any peer you connect to can see the `privateTopic` name your nodes are subscribed to. A node running modified software could then subscribe to the same topic and join your network. Message signatures prevent forgery, but they do not prevent eavesdropping or participation by rogue nodes that have learned your topic name.
