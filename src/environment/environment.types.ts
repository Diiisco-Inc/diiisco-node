import PeerId from 'peer-id';
import { QuoteCreationFunction, QuoteSelectionFunction } from '../types/quotes';

export interface AlgorandClientConfig {
  address: string;
  port: number;
  token: string;
}

export interface AlgorandConfig {
  mnemonic: string;                   // wallet identity + signing key; the address is derived from this
  client: AlgorandClientConfig;
  network?: 'mainnet' | 'testnet';    // selects the USDC ASA + CAIP-2 id used by x402 settlement
  nfd?: string;
  settlement?: SettlementConfig;      // x402 settlement; omit → node cannot settle on the public network
}

/**
 * Per-1M-token rate. A bare `number` is shorthand for equal input/output rates
 * (`{ input: n, output: n }`) — keeps existing scalar configs working unchanged.
 */
export type TokenRate = number | { input: number; output: number };

export interface ModelsConfig {
  enabled: boolean;
  baseURL: string;
  port: number;
  apiKey: string;
  chargePer1MTokens?: {
    default: TokenRate;
    [key: string]: TokenRate;
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
  quoteSelectionFunction?: QuoteSelectionFunction | QuoteSelectionFunction[]; // one strategy, or a list tried in order
  quoteCreationFunction?: QuoteCreationFunction;                              // override to price dynamically; default = createStandardQuote
  optimisticInference?: boolean;  // default true — provider starts inference in parallel with createQuote
  maxSpeculativeJobs?: number;    // default 2 — max concurrent speculative inference jobs
  defaultMaxOutputTokens?: number; // cap used for maxCharge when a request omits max_tokens (default 4096)
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

export interface X402Config {
  facilitatorUrl?: string;            // default https://facilitator.goplausible.xyz/
  selfSubmitFallback?: boolean;       // default true — submit signed group to algod if facilitator settle fails
}

export interface SettlementConfig {
  // Accepted/offered settlement methods, preference-ordered. Default ['x402'].
  // Network + USDC asset are taken from the parent `algorand.network`.
  methods?: 'x402'[];
  x402?: X402Config;
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