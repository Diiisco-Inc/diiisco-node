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
  chargePer1MTokens?: {
    default: number;
    [key: string]: number;
  };
  chargePer1KTokens?: {
    default: number;
    [key: string]: number;
  };
}

export interface ApiConfig {
  enabled: boolean;
  bearerAuthentication: boolean;
  keys: string[];
  port: number;
  networkWaitTime?: number;
  profileWaitTime?: number;  // ms to wait for a remote node-profile response (default 3000)
  profileCacheTtl?: number;  // ms to cache fetched profiles (default 45000)
}


export interface QuoteEngineConfig {
  waitTime: number;
  preferSelf?: boolean;
  quoteSelectionFunction?: (quotes: QuoteEvent[]) => Promise<QuoteEvent>;
  quoteCreationFunction?: QuoteCreationFunction | QuoteCreationFunction[];
  optimisticInference?: boolean;  // default true — provider starts inference in parallel with createQuote
  maxSpeculativeJobs?: number;    // default 2 — max concurrent speculative inference jobs
}

export interface PeerIdStorageConfig {
  path: string;
}

export interface PeerIdConfig extends PeerId.JSONPeerId {}

export interface DirectMessagingConfig {
  enabled: boolean;
  timeout: number;
  fallbackToGossipsub: boolean;
  protocol: string;
  maxMessageSize: number;
}

export interface LocalConfig {
  enabled: boolean;
  privateTopic?: string;
}

export interface Environment {
  local?: LocalConfig;
  peerIdStorage: PeerIdStorageConfig;
  models: ModelsConfig;
  algorand?: AlgorandConfig;
  api: ApiConfig;
  quoteEngine: QuoteEngineConfig;
  libp2pBootstrapServers?: string[]; // Array of multiaddrs for LibP2P bootstrapping
  // Add a new property for the server URL
  node?: {
    url?: string;
    port?: number;
    displayName?: string;
    publicStats?: boolean;  // default true — set false to stop publishing detailed stats on status pages
    statusPages?: boolean;  // default true — set false to disable the public status page routes
  };
  directMessaging?: DirectMessagingConfig;  // Optional: uses defaults if not provided
}