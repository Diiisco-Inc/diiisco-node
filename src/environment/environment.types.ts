import PeerId from 'peer-id';

export interface AlgorandClientConfig {
  address: string;
  port: number;
  token: string;
}

export interface AlgorandConfig {
  addr: string;
  mnemonic: string;
  client: AlgorandClientConfig;
  paymentAssetId: number;
  paymentAssetDecimals?: number;
  nfd?: string;
}

export interface ModelsConfig {
  enabled: boolean;
  baseURL: string;
  port: number;
  apiKey: string;
  chargePer1KTokens: {
    default: number;
    [key: string]: number;
  };
}

export interface ApiConfig {
  enabled: boolean;
  bearerAuthentication: boolean;
  keys: string[];
  port: number;
}

export interface QuoteEngineConfig {
  waitTime: number;
}

export interface PeerIdStorageConfig {
  path: string;
}

export interface PeerIdConfig extends PeerId.JSONPeerId {}

export interface Environment {
  peerIdStorage: PeerIdStorageConfig;
  models: ModelsConfig;
  algorand: AlgorandConfig;
  api: ApiConfig;
  quoteEngine: QuoteEngineConfig;
  libp2pBootstrapServers?: string[]; // Array of multiaddrs for LibP2P bootstrapping
  // Add a new property for the server URL
  node?: {
    url?: string;
    port?: number;
  };
}