/**
 * Lifetime counters surfaced on the public status pages when the node opts in
 * via `node.publicStats`. Kept as a module singleton so the API server and the
 * message processor increment the same counts without extra wiring.
 */
class NodeStats {
  readonly startedAt = Date.now();
  inferencesServed = 0;
  inferencesRequested = 0;

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}

export const nodeStats = new NodeStats();
