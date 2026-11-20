import { ExpiringMap } from '../utils/expiringMap';

/** Most models one peer may list in a single response. */
export const MAX_MODELS_PER_RESPONSE = 200;
/** Most responses (distinct peers) kept for one collection. */
export const MAX_RESPONDERS = 256;
/** Longest model id kept; anything longer is not a model id. */
export const MAX_MODEL_ID_LENGTH = 256;

interface Collection {
  /** peer id → the models that peer listed. One entry per peer. */
  byPeer: Map<string, any[]>;
}

/**
 * Requester-side collection of `list-models-response`s.
 *
 * A request id travels in the clear on the broadcast `list-models`, and a
 * response is a stranger's bytes, so a response is kept only while this node
 * has that exact request open, and only the first from each peer. What it
 * carries is bounded in count and size. Nothing here starts a timer: whoever
 * opened the collection decides when to read it, so an unsolicited response
 * can never cause work, nor grow anything that outlives its own request.
 */
export class ModelListCollector {
  private open_ = new ExpiringMap<string, Collection>();

  /** Start collecting for request `id`. Dropped by `close` or after `ttlMs`. */
  open(id: string, ttlMs: number): void {
    this.open_.set(id, { byPeer: new Map() }, ttlMs);
  }

  isOpen(id: string): boolean {
    return this.open_.has(id);
  }

  /** Offer one peer's response. Returns true only if it was kept. */
  add(id: string, peerId: string, models: unknown): boolean {
    const collection = this.open_.get(id);
    if (!collection) return false;
    if (collection.byPeer.has(peerId) || collection.byPeer.size >= MAX_RESPONDERS) return false;
    if (!Array.isArray(models)) return false;

    const valid = models
      .filter((m) => typeof m === 'object' && m !== null && typeof m.id === 'string'
        && m.id.length > 0 && m.id.length <= MAX_MODEL_ID_LENGTH)
      .slice(0, MAX_MODELS_PER_RESPONSE);
    collection.byPeer.set(peerId, valid);
    return true;
  }

  /** Stop collecting `id` and return the models heard, one entry per model id. */
  close(id: string): any[] {
    const collection = this.open_.take(id);
    if (!collection) return [];
    const unique = new Map<string, any>();
    for (const models of collection.byPeer.values()) {
      for (const m of models) if (!unique.has(m.id)) unique.set(m.id, m);
    }
    return [...unique.values()];
  }
}
