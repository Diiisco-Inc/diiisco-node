import { Environment } from "./environment.types"; // Import the new interface
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";
import { createQuoteFromInputTokens } from "../utils/quoteCreationMethods";

const environment: Environment = {
  peerIdStorage: {
    path: "~/Desktop/"
  },
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
      "sk-testkey1",
      "sk-testkey2"
    ],
    port: 8080
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
    port: 4242
  },

  // ============================================================================
  // OPTIONAL: Relay and Direct Messaging Configuration
  // ============================================================================
  // The following configurations are OPTIONAL. If omitted, sensible defaults
  // will be used automatically. Only include these if you need to customize
  // the default behavior.
  //
  // Default relay config (used if omitted):
  // - enableRelayServer: true (auto-disabled by AutoNAT if behind NAT)
  // - enableRelayClient: true
  // - enableDCUtR: true (upgrades relayed connections to direct)
  // - maxRelayedConnections: 100
  // - maxDataPerConnection: 100 MB
  // - maxRelayDuration: 5 minutes
  //
  // Default directMessaging config (used if omitted):
  // - enabled: true
  // - timeout: 10 seconds
  // - fallbackToGossipsub: true (always fallback for reliability)
  // - protocol: '/diiisco/direct/1.0.0'
  // - maxMessageSize: 10 MB
  //
  // Uncomment below to customize (otherwise defaults are used):
  // ============================================================================

  // relay: {
  //   enableRelayServer: true,
  //   autoEnableRelay: true,
  //   maxRelayedConnections: 100,
  //   enableRelayClient: true,
  //   enableDCUtR: true,
  //   maxDataPerConnection: 104857600,  // 100 MB
  //   maxRelayDuration: 300000,  // 5 minutes
  // },

  // directMessaging: {
  //   enabled: true,
  //   timeout: 10000,
  //   fallbackToGossipsub: true,
  //   protocol: '/diiisco/direct/1.0.0',
  //   maxMessageSize: 10485760,  // 10 MB
  // },
}

export default environment;