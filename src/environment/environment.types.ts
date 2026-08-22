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
 * The `algorand` block as it appears in `diiisco.config.json`.
 *
 * `mnemonic` is optional here because it does not belong in that file: the
 * wallet key lives on its own in `~/.diiisco/algorand-key.json`. It is still
 * *accepted* — a config written before the split, or by hand — and the node
 * moves it to the key file on startup (`src/cli/keyMigration.ts`).
 */
export type AlgorandFileConfig = Omit<AlgorandConfig, 'mnemonic'> & { mnemonic?: string };

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
  // Requester's per-request spending limit in USDC (§4.2). Sent in the
  // quote-request and enforced locally before signing. Unset ⇒ the node refuses
  // to pay (never signs an unbounded cheque).
  maxSpend?: number;
  x402?: X402Config;
}

/** Wire protocol a launch target speaks (`diiisco launch <app>`). */
export type CliWireProtocol = 'anthropic' | 'openai';

/**
 * A user-defined launch target, merged over (and able to override) the CLI's
 * built-in app map:
 *
 *   { "cli": { "apps": { "aider": { "bin": "aider", "wire": "openai" } } } }
 */
export interface CliAppConfig {
  bin: string;                 // executable to look up on PATH
  wire: CliWireProtocol;       // which env vars to set before spawning it
  installHint?: string;        // shown when `bin` is not on PATH
  args?: string[];             // arguments prepended to the user's positional args
}

export interface CliConfig {
  apps?: { [name: string]: CliAppConfig };
  // Terminal emulator the desktop app should spawn for launch buttons.
  // A bare string applies everywhere; the object form is per-platform
  // (keys are `process.platform` values, e.g. "darwin" | "win32" | "linux").
  terminal?: string | { [platform: string]: string };
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
  cli?: CliConfig;                          // Optional: DIIISCO CLI extensions (extra `launch` targets)
}

/**
 * The `quoteEngine` block as it appears in `diiisco.config.json`.
 *
 * `Environment` types the two strategy hooks as functions, which JSON cannot
 * express, so on the file side they are also accepted as **strategy names**
 * (`"selectHighestStakeQuote"`) and resolved on load — see
 * `src/environment/strategies.ts`. Functions are still accepted here so a
 * programmatic `Partial<Environment>` is assignable to an `EnvironmentFile`.
 */
export interface QuoteEngineFileConfig extends Omit<Partial<QuoteEngineConfig>, 'quoteSelectionFunction' | 'quoteCreationFunction'> {
  quoteSelectionFunction?: string | string[] | QuoteSelectionFunction | QuoteSelectionFunction[];
  quoteCreationFunction?: string | QuoteCreationFunction;
}

/**
 * The on-disk shape of `diiisco.config.json`: `Environment` with the
 * function-valued fields widened to their JSON-expressible name form, and the
 * wallet key made optional because it belongs in `algorand-key.json`. Resolving
 * it with `resolveStrategies()` yields a `Partial<Environment>`.
 */
export type EnvironmentFile = Omit<Partial<Environment>, 'quoteEngine' | 'algorand'> & {
  quoteEngine?: QuoteEngineFileConfig;
  algorand?: AlgorandFileConfig;
};