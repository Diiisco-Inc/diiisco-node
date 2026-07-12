/**
 * Public profile of a node, served unauthenticated on the status pages
 * (`/node.json`, `/nodes/{peerId}.json`) and exchanged over the mesh via the
 * `node-profile` message pair. Identity fields are always present; `stats` is
 * included by default and omitted when the node opts out via
 * `node.publicStats: false`.
 */
export interface NodeProfileStats {
  models: { id: string; pricePer1MTokens?: number }[];
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
  stats?: NodeProfileStats;
}

/**
 * Aggregate pricing for one model across the host and its connected nodes,
 * served at `/models.json`. Price fields are null when no serving node
 * publishes a price.
 */
export interface ModelStats {
  model: string;
  nodes: number;
  minPrice: number | null;
  maxPrice: number | null;
  meanPrice: number | null;
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
