import PeerId from 'peer-id';
import { QuoteEvent } from '../types/messages';
import { QuoteCreationFunction } from '../types/quotes';

export interface AlgorandClientConfig {
  address: string;
  port: number;
  token: string;
}

export interface AlgorandConfig {
  addr: string;
  mnemonic: string;
  client: AlgorandClientConfig;
  network?: 'mainnet' | 'testnet';
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
  quoteSelectionFunction?: (quotes: QuoteEvent[]) => Promise<QuoteEvent>;
  quoteCreationFunction?: QuoteCreationFunction | QuoteCreationFunction[];
}

export interface PeerIdStorageConfig {
  path: string;
}

export interface PeerIdConfig extends PeerId.JSONPeerId {}

export interface RelayConfig {
  enableRelayServer: boolean;
  autoEnableRelay: boolean;
  maxRelayedConnections: number;
  enableRelayClient: boolean;
  enableDCUtR: boolean;
  maxDataPerConnection: number;
  maxRelayDuration: number;
}

export interface DirectMessagingConfig {
  enabled: boolean;
  timeout: number;
  fallbackToGossipsub: boolean;
  protocol: string;
  maxMessageSize: number;
}

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
  relay?: RelayConfig;  // Optional: uses defaults if not provided
  directMessaging?: DirectMessagingConfig;  // Optional: uses defaults if not provided
}