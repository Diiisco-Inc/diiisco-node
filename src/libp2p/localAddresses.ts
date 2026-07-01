/**
 * Small decoupled registry for the local node's current multiaddrs.
 *
 * The message-signing chokepoint (`algorand.signObject`) needs to stamp our
 * current addresses onto every outgoing message so peers can dial us over a
 * relay circuit without a DHT lookup. Rather than couple the Algorand utility
 * to libp2p, the Application registers a provider here once the node is up.
 */
let provider: (() => string[]) | null = null;

/**
 * Register a function that returns the local node's current multiaddrs as
 * strings. Called once at startup after the libp2p node is created.
 */
export const setLocalAddressProvider = (fn: () => string[]): void => {
  provider = fn;
};

/**
 * Get the local node's current multiaddrs. Returns an empty array if no
 * provider has been registered yet (e.g. before the node has started).
 */
export const getLocalMultiaddrs = (): string[] => {
  if (!provider) return [];
  try {
    return provider();
  } catch {
    return [];
  }
};
