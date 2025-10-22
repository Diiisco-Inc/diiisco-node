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

export interface PeerIdConfig extends PeerId.JSONPeerId {}

export interface Environment {
  models: ModelsConfig;
  algorand: AlgorandConfig;
  api: ApiConfig;
  quoteEngine: QuoteEngineConfig;
  peerId?: PeerIdConfig; // PeerId will be stored here
}