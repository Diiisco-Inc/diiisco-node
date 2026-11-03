/**
 * Limits a public node's circuit-relay server puts on each relayed connection.
 *
 * A relayed connection is cut when it reaches either limit, and everything on
 * it goes with it: GossipSub, direct messages, an inference in flight. The old
 * fixed limits (10 minutes, 25 MB) were chosen to match one OpenAI request, but
 * a relayed connection carries the mesh for as long as two peers stay
 * connected. Peers that reached each other only through a relay therefore all
 * dropped together, exactly 10 minutes after they connected, and stayed gone.
 *
 * The limits are per connection, so they bound how long one relayed peer pair
 * can hold a slot; the number of reservations is capped separately.
 */

/** A relayed connection lasts an hour before the relay cuts it. */
export const DEFAULT_RELAY_CONNECTION_MINUTES = 60;
/** Data a relayed connection may carry before the relay cuts it. */
export const DEFAULT_RELAY_CONNECTION_MEGABYTES = 100;

export interface RelayLimitConfig {
  connectionMinutes?: number;
  connectionMegabytes?: number;
}

export interface RelayLimits {
  durationLimitMs: number;
  dataLimitBytes: bigint;
}

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** The relay limits for `config` (`node.relay`), with defaults for anything unset or not a positive number. */
export function relayLimits(config?: RelayLimitConfig): RelayLimits {
  const minutes = positive(config?.connectionMinutes, DEFAULT_RELAY_CONNECTION_MINUTES);
  const megabytes = positive(config?.connectionMegabytes, DEFAULT_RELAY_CONNECTION_MEGABYTES);
  return {
    durationLimitMs: Math.round(minutes * 60_000),
    dataLimitBytes: BigInt(Math.round(megabytes * 1024 * 1024)),
  };
}
