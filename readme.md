<img src="https://github.com/Diiisco-Inc/diiisco-node/blob/main/assets/diiisco-logo.png?raw=true" width="1000" />

Diiisco is a globally distributed network of machines running large language models. Send a prompt to any node on the Diiisco network and our shared compute will get you a response from the model of your choice. If you have a laptop, a desktop or a super computer you can join the Diiisco network, contribute your compute and get rewarded in Algorand - it's fast, efficient and getter than paying $25 a month! 

## 👋 Join the Network

Joining the network is easy, all you need is a computer, and Algorand wallet and a locally running Large language Model (LLM). 

### 🦙 Run Your Own Large Language Model

The get started you'll a Local LLM Inference Runtime like [Shimmy](https://github.com/Michael-A-Kuykendall/shimmy) or [Ollama](https://ollama.com/) to serve your models. To install Ollama, head to their website and download the application. To install Shimmy follow the instructions on their [GitHub repo](https://github.com/Michael-A-Kuykendall/shimmy).

Once you have your Model Runtime installed, then download a model. We recommend small models for laptops, medium for desktop PCs and larger models for gaming PCs are equipment with dedicated GPUs. Then download this repo, install dependencies, set your configuration environment and run using Node.JS!

### Get Setup with Algorand

It's easy to start accepting payment with Algorand. We recommend [Pera Wallet](https://perawallet.app/) which you can downlaod on iOS and Android. Once you have your wallet, you'll need your wallet address and secret mnemonic passphrase (it's a list of 24 words).

⚠️ Never share or paste your mnemonic onto a computer you don't control. Keep it secret, keep it safe.

### 📦 Download and Install Diiisco Node

```
git clone https://github.com/Diiisco-Inc/diiisco-node.git
npm install
```

### 🌍 Set your Environment
 Rename src/environment/example.environment.ts to src/environment/environment.ts and edit you options.

 ```
 const environment: any = {
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,
    apiKey: "YOUR_LOCAL_LLM_API_KEY_HERE_OFTEN_NOT_NEEDED",
    chargePer1KTokens: {
      default: 0.000001,
      "gpt-oss:20b": 0.000002,
    }
  },
  algorand: {
    addr: "YOUR_ALGORAND_ADDRESS_HERE",
    mnemonic: "YOUR_ALGORAND_MNEMONIC_HERE",
    client: {
      address: "https://mainnet-api.algonode.cloud/",
      port: 443,
      token: ""
    },
    paymentAssetId: 0
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: [
      "sk-testkey1",
      "sk-testkey2"
    ],
    port: 8181
  },
  quoteEngine: {
    waitTime: 1000
  }
}
```

### 🚀 You're Ready to Go

Then build and run the Diiisco Node with one easy command.

```
npm run serve
```

## 👀 See it in Action

Not sure is globally distributed compute is right for you? Head over to [Our Demo Page](https://diiisco.tunn.dev) and explore how it works in action.

<img src="https://github.com/Diiisco-Inc/diiisco-node/blob/main/assets/ui_screenshot.png?raw=true" width="1000" />

## ❤️ Love Diiisco, Use Diiisco

Any Diiisco Node can share a set of REST API endpoints and these endpoints are identical to the OpenAI standard endpoints, for that reason, it's easy to substitute Diiisco into any codebase where you would call the OpenAI API or use the OpenAI SDK.

Diiisco is Open-source and free forever. Whilst we operate a single mainnet, there is nothing to stop you creating your own Diiisco network - for example for your workplace or home.

Over the coming few weeks we'll be expanding Diiisco further. Ironing out bugs and making the system even more capable.