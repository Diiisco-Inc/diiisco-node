import { Environment } from "./environment.types";
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";
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
      // Price per 1M tokens in USDC. A bare number sets equal input/output
      // rates; use { input, output } to price them separately (x402 meters the
      // actual charge from real token usage, capped at the quoted maximum).
      default: 0.01703,
      "gpt-oss:20b": { input: 0.02, output: 0.06 }, // Per-model split-rate override
    },
    // How often the node re-checks that the backend is really serving these
    // models. Stop Ollama and the node stops quoting rather than winning
    // auctions it cannot honour. The defaults shown are the built-in ones.
    availability: {
      checkIntervalMs: 30000,               // Background re-probe interval; 0 disables polling
      freshForMs: 10000,                    // Max snapshot age tolerated when answering a quote-request
      timeoutMs: 2000,                      // Per-probe timeout on the backend
    },
  },
  algorand: {
    mnemonic: "YOUR_ALGORAND_MNEMONIC_HERE", // Wallet identity + signing key; the address is derived from this
    network: "mainnet",                     // Selects the USDC ASA + CAIP-2 id used by x402 settlement
    client: {
      address: "https://mainnet-api.algonode.cloud/",
      port: 443,
      token: ""
    },
    nfd: "your-name.diiisco.algo",          // Optional: .diiisco.algo NFD domain for verified identity
    settlement: {
      // Settlement methods offered/accepted, in preference order. x402 is the
      // only method (escrow has been retired). Omit to disable public settlement.
      methods: ["x402"],
      // Per-request spending limit in USDC. As a requester this is the most the
      // node will ever pay for one request — it refuses to sign anything above
      // it, and refuses to pay at all if this is unset. As a provider it's what
      // requesters send you to budget their quote + generation against.
      maxSpend: 0.10,
      x402: {
        facilitatorUrl: "https://facilitator.goplausible.xyz/",
        selfSubmitFallback: true,           // Submit the signed group to algod if the facilitator is down
      },
    },
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
    // How to pick a quote: selectHighestStakeQuote (default), selectCheapestQuote,
    // selectFastestQuote, a custom function, or a list tried in order.
    quoteSelectionFunction: selectHighestStakeQuote,
    // Optional: override pricing with a custom function (same signature as
    // createStandardQuote) for dynamic/surge pricing. Defaults to the standard quote.
    preferSelf: true,                       // Serve requests locally when the model is available, bypassing the network
    auctionTimeout: 6000,                   // Give up if no quote is selected in time (default waitTime + 5000)
    inferenceTimeout: 300000,               // Overall deadline for one auction attempt (ms)
    maxRetries: 1,                          // Re-auctions after a provider reports inference-failed
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
