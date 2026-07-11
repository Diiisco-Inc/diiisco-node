// Mirrors src/types/profile.ts in the node — keep the two in sync when the
// profile shape changes.

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

export interface DirectoryEntry {
  peerId: string;
  displayName?: string;
  nfd?: string;
  walletAddr?: string;
  connected: boolean;
  role?: 'relay' | 'relayed' | 'direct';
  lastSeen: number;
}
