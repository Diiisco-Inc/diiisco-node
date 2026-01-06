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
  }
}

export default environment;