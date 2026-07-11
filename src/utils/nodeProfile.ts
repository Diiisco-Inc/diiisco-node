import { readFileSync } from 'fs';
import { NodeProfile } from '../types/profile';
import { nodeStats } from './nodeStats';
import { isPublicNode } from '../libp2p/node';
import { getMeshTopic } from './topic';
import environment from '../environment/environment';
import algorand from './algorand';

let cachedVersion: string | undefined;

/** Package version, resolved relative to the bundled module (dist/index.js). */
const getVersion = (): string | undefined => {
  if (cachedVersion !== undefined) return cachedVersion;
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf-8'));
      if (pkg.name === 'diiisco-node' && typeof pkg.version === 'string') {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    } catch {}
  }
  cachedVersion = undefined;
  return undefined;
};

/**
 * Build this node's own public profile. Identity fields are always included;
 * the stats block too, unless the operator opts out with `node.publicStats: false`.
 * Shared by the status page routes (serving `/node.json`) and the
 * `node-profile` message handler (answering queries from relays).
 */
export const buildOwnProfile = (node: any, algo: algorand, availableModels: string[]): NodeProfile => {
  const localMode = environment.local?.enabled === true;

  let role: NodeProfile['role'] = 'direct';
  if (isPublicNode()) {
    role = 'relay';
  } else {
    const addrs: string[] = node.getMultiaddrs().map((a: any) => a.toString());
    if (addrs.some((a) => a.includes('/p2p-circuit'))) role = 'relayed';
  }

  const profile: NodeProfile = {
    peerId: node.peerId.toString(),
    displayName: environment.node?.displayName,
    nfd: algo.nfdVerified ? (algo.nfdAddr ?? undefined) : undefined,
    nfdVerified: algo.nfdVerified || undefined,
    walletAddr: localMode ? undefined : algo.account.addr.toString(),
    role,
    online: true,
    network: localMode ? 'local' : 'public',
    observedAt: new Date().toISOString(),
    version: getVersion(),
  };

  if (environment.node?.publicStats !== false) {
    const rates = environment.models.chargePer1MTokens;
    profile.stats = {
      models: availableModels.map((id) => ({
        id,
        pricePer1MTokens: rates?.[id] ?? rates?.default,
      })),
      connectedPeers: node.getConnections().length,
      meshReady: localMode || node.services.pubsub.getSubscribers(getMeshTopic()).length > 0,
      uptimeSeconds: nodeStats.uptimeSeconds,
      inferencesServed: nodeStats.inferencesServed,
      inferencesRequested: nodeStats.inferencesRequested,
    };
  }

  return profile;
};
