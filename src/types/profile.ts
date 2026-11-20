import type { ModelKind } from './models';
import type { ModelPerformance } from './performance';

/**
 * Public profile of a node, served unauthenticated on the status pages
 * (`/node.json`, `/nodes/{peerId}.json`) and exchanged over the mesh via the
 * `node-profile` message pair. Identity fields are always present; `stats` is
 * included by default and omitted when the node opts out via
 * `node.publicStats: false`.
 */
export interface NodeProfileStats {
  // pricePer1MTokens retained for back-compat (= input rate); input/output split added.
  models: {
    id: string;
    pricePer1MTokens?: number;
    pricePerInputToken1M?: number;
    pricePerOutputToken1M?: number;
    /** Present only for models that are not `chat`; absent means a chat model (or an older node). */
    kind?: Exclude<ModelKind, 'chat'>;
    /** Measured figures for a chat model (plan 018). Self-reported; absent until measured. */
    performance?: ModelPerformance;
  }[];
  connectedPeers: number;
  meshReady: boolean;
  uptimeSeconds: number;
  inferencesServed: number;
  inferencesRequested: number;
}

export interface NodeProfile {
  peerId: string;
  displayName?: string;
  nfd?: string;
  nfdVerified?: boolean;
  walletAddr?: string;
  role: 'relay' | 'relayed' | 'direct';
  online: boolean;
  network: 'public' | 'local';
  observedAt: string;
  version?: string;
  /** The operator's `node.tags`. Identity, so published even when `publicStats` is false. Self-declared. */
  tags?: string[];
  stats?: NodeProfileStats;
}

/**
 * Aggregate pricing for one model across the host and its connected nodes,
 * served at `/models.json`. Price fields are null when no serving node
 * publishes a price.
 */
export interface ModelStats {
  model: string;
  /** The model's non-chat kind as reported by the first node that serves it; absent for chat models. */
  kind?: Exclude<ModelKind, 'chat'>;
  nodes: number;
  minPrice: number | null;
  maxPrice: number | null;
  meanPrice: number | null;
  /** Spread of each figure across the nodes that publish one (plan 018); null when none do. */
  tokensPerSecond: FigureRange | null;
  ttftHotMs: FigureRange | null;
  ttftColdMs: FigureRange | null;
}

export interface FigureRange {
  min: number;
  median: number;
  max: number;
  /** How many nodes contributed. */
  nodes: number;
}

/**
 * A row in the `/nodes` directory. Identity-only regardless of the remote
 * node's `publicStats` setting — stats appear only on the individual profile
 * page after a live `node-profile` query.
 */
export interface DirectoryEntry {
  peerId: string;
  displayName?: string;
  nfd?: string;
  walletAddr?: string;
  connected: boolean;
  role?: 'relay' | 'relayed' | 'direct';
  lastSeen: number;
  host?: boolean; // true on the entry describing the node serving the directory
}
