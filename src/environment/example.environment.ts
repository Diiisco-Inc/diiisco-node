import { Environment } from "./environment.types";
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";
import { createQuoteFromInputTokens } from "../utils/quoteCreationMethods";
import { deepMerge } from "../utils/deepMerge";

const environment: Environment = {
  peerIdStorage: {
    path: "~/Desktop/"                      // Where to store your peer identity file
  },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,                            // Default Ollama port
    apiKey: "YOUR_LOCAL_LLM_API_KEY_HERE_OFTEN_NOT_NEEDED",
    chargePer1MTokens: {
      default: 0.01703,                     // Price per 1M tokens in USDC
      "gpt-oss:20b": 0.02,                  // Per-model override
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
    nfd: "your-name.diiisco.algo",          // Optional: .diiisco.algo NFD domain for verified identity
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: [
      "sk-testkey1",                        // API keys for client authentication
      "sk-testkey2"
    ],
    port: 8080,
    networkWaitTime: 10000,                 // Time to wait for network responses before timing out (ms)
  },
  quoteEngine: {
    waitTime: 1000,                         // Time to collect quotes before selecting one (ms)
    quoteSelectionFunction: selectHighestStakeQuote,
    quoteCreationFunction: [createQuoteFromInputTokens],
    preferSelf: true,                       // Serve requests locally when the model is available, bypassing the network
  },
  libp2pBootstrapServers: [
    "lon.diiisco.algo",
    "nyc.diiisco.algo",
  ],
  node: {
    url: "http://localhost",
    port: 4242,                             // Port for node-to-node communication
    displayName: "My Diiisco Node",         // Human-readable name shown on the network
  },
  local: {
    enabled: false,                         // Set true to disable Algorand payments (private networks only)
    privateTopic: "my-network-name/models/1.0.0" // Unique topic — isolates this cluster from the public network
  },
};

/**
 * Override environment settings. Call BEFORE creating Application instance.
 */
export function configureEnvironment(overrides: Partial<Environment>): void {
  Object.assign(environment, deepMerge(environment, overrides));
}

export default environment;
