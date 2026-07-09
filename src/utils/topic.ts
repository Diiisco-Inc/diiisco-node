import environment from '../environment/environment';

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
