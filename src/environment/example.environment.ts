import { Environment } from "./environment.types";
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";
import { createQuoteFromInputTokens } from "../utils/quoteCreationMethods";
import { deepMerge } from "../utils/deepMerge";

const environment: Environment = {
  peerIdStorage: {
    path: "~/Desktop/"
  },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,
    apiKey: "YOUR_LOCAL_LLM_API_KEY_HERE_OFTEN_NOT_NEEDED",
    chargePer1MTokens: {
      default: 0.01703,
      "gpt-oss:20b": 0.02,
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
};

/**
 * Override environment settings. Call BEFORE creating Application instance.
 */
export function configureEnvironment(overrides: Partial<Environment>): void {
  Object.assign(environment, deepMerge(environment, overrides));
}

export default environment;