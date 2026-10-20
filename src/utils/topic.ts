import { createHash } from 'node:crypto';
import environment from '../environment/runtime';

/** The public network's GossipSub topic — the default all nodes share. */
export const PUBLIC_TOPIC = 'diiisco/models/1.0.0';

/**
 * Resolve the GossipSub topic this node publishes to and subscribes on.
 *
 * A `privateTopic` isolates a node from the public network, so it must only
 * take effect when local/private mode is actually enabled. Otherwise a stray
 * `privateTopic` left in a config (e.g. the example config's placeholder)
 * would silently move the node onto a private topic with no other subscribers,
 * making its GossipSub mesh never become ready.
 */
export function getMeshTopic(): string {
  const local = environment.local;
  return local?.enabled && local.privateTopic ? local.privateTopic : PUBLIC_TOPIC;
}

/** The network id of the public network. */
export const PUBLIC_NETWORK_ID = 'public';

/**
 * A short id for the network this node belongs to: `public`, or
 * `local-<16 hex of sha256(privateTopic)>` in local mode.
 *
 * It uses the same rule as `getMeshTopic()` so the two can never disagree, and
 * it is what keeps a private cluster off the public network's mDNS tag, DHT
 * protocol and connections (see `src/libp2p/networkGuard.ts`).
 */
export function getNetworkId(): string {
  const local = environment.local;
  if (!(local?.enabled && local.privateTopic)) return PUBLIC_NETWORK_ID;
  return `local-${createHash('sha256').update(local.privateTopic).digest('hex').slice(0, 16)}`;
}
