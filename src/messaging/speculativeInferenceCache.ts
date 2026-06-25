import { logger } from '../utils/logger';

const TTL_MS = 120_000;

interface CacheEntry {
  promise: Promise<unknown>;
  createdAt: number;
}

export class SpeculativeInferenceCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxJobs: number;

  constructor(maxJobs: number) {
    this.maxJobs = maxJobs;
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref();
  }

  start(quoteId: string, work: () => Promise<unknown>): void {
    if (this.cache.size >= this.maxJobs) {
      logger.debug(`⚡ Speculative cache full (${this.maxJobs}) — skipping ${quoteId}`);
      return;
    }
    const promise = work();
    // Self-evict on failure; .catch here prevents an unhandled-rejection warning.
    // The rejection is re-surfaced as null when resolve() awaits the stored promise.
    promise.catch(() => this.cache.delete(quoteId));
    this.cache.set(quoteId, { promise, createdAt: Date.now() });
    logger.debug(`⚡ Speculative inference started for ${quoteId}`);
  }

  async resolve(quoteId: string): Promise<unknown | null> {
    const entry = this.cache.get(quoteId);
    if (!entry) return null;
    this.cache.delete(quoteId);
    try {
      const result = await entry.promise;
      logger.info(`⚡ Speculative inference hit for ${quoteId}`);
      return result;
    } catch {
      return null;
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, entry] of this.cache) {
      if (entry.createdAt < cutoff) {
        this.cache.delete(id);
        logger.debug(`⚡ Evicted stale speculative entry ${id}`);
      }
    }
  }
}
