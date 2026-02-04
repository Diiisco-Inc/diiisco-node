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
    path: "~/Desktop/"                    // Where to store your peer identity
  },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,                          // Default Ollama port
    apiKey: "",                           // Usually not needed for local LLMs
    chargePer1MTokens: {
      default: 0.001,                     // Price per 1M tokens in USDC
      "gpt-oss:20b": 0.002,               // Custom pricing per model
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
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: [
      "sk-your-api-key-1",                // API keys for client authentication
      "sk-your-api-key-2"
    ],
    port: 8080                            // Port for the REST API
  },
  quoteEngine: {
    waitTime: 1000,
    quoteSelectionFunction: selectHighestStakeQuote,
    quoteCreationFunction: [createQuoteFromInputTokens]
  },
  libp2pBootstrapServers: [
    "lon.diiisco.algo",
    "nyc.diiisco.algo",
  ],
  node: {
    url: "http://localhost",
    port: 4242                            // Port for node-to-node communication
  },
}
```

### 🚀 You're Ready to Go

For development or testing, build and run with:

```bash
npm run serve
```

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

Diiisco is open-source and free forever. While we operate a single mainnet, you're welcome to create your own Diiisco network for your workplace or home.
