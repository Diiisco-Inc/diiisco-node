import dotenv from 'dotenv';
import { Environment } from "./environment.types";

dotenv.config();

const environment: Environment = {
  peerIdStorage: {
    path: process.env.PEER_ID_STORAGE_PATH || "~/"
  },
  models: {
    enabled: process.env.MODELS_ENABLED === 'true',
    baseURL: process.env.MODELS_BASE_URL || "http://localhost",
    port: parseInt(process.env.MODELS_PORT || "11434", 10),
    apiKey: process.env.MODELS_API_KEY || "YOUR_LOCAL_LLM_API_KEY_HERE_OFTEN_NOT_NEEDED",
    chargePer1KTokens: {
      default: parseFloat(process.env.MODELS_CHARGE_DEFAULT || "0.01"),
    }
  },
  algorand: {
    addr: process.env.ALGORAND_ADDR || "",
    mnemonic: process.env.ALGORAND_MNEMONIC || "",
    client: {
      address: process.env.ALGORAND_CLIENT_ADDRESS || "",
      port: parseInt(process.env.ALGORAND_CLIENT_PORT || "443", 10),
      token: process.env.ALGORAND_CLIENT_TOKEN || ""
    },
    paymentAssetId: parseInt(process.env.ALGORAND_PAYMENT_ASSET_ID || "31566704", 10)
  },
  api: {
    enabled: process.env.API_ENABLED === 'true',
    bearerAuthentication: process.env.API_BEARER_AUTHENTICATION === 'true',
    keys: process.env.API_KEYS ? process.env.API_KEYS.split(',') : [],
    port: parseInt(process.env.API_PORT || "8080", 10)
  },
  quoteEngine: {
    waitTime: parseInt(process.env.QUOTE_ENGINE_WAIT_TIME || "1000", 10)
  },
  libp2pBootstrapServers: process.env.LIBP2P_BOOTSTRAP_SERVERS ? process.env.LIBP2P_BOOTSTRAP_SERVERS.split(',') : [],
  node: {
    url: process.env.NODE_URL || "localhost",
    port: parseInt(process.env.NODE_PORT || "4242", 10)
  }
};

export default environment;