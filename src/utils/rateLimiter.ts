/**
 * A token-bucket rate limiter keyed by an arbitrary string (an IP, a peer id).
 *
 * Keys can be chosen by remote parties, so the table is bounded: idle buckets
 * are swept, and if it is still full the least recently used key is evicted.
 * An evicted key simply starts again with a full bucket, so the bound costs a
 * flooder nothing but cannot be used to exhaust memory.
 */
export interface RateLimiterOptions {
  /** Largest burst: the bucket's capacity, and what a new key starts with. */
  capacity: number;
  /** Tokens added per millisecond. */
  refillPerMs: number;
  /** Most keys remembered at once. Default 5000. */
  maxKeys?: number;
  /** Clock, for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.maxKeys = options.maxKeys ?? 5000;
    this.now = options.now ?? Date.now;
  }

  /** Spend `cost` tokens for `key`. Returns false (and spends nothing) if it has too few. */
  take(key: string, cost = 1): boolean {
    const now = this.now();
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: this.capacity, last: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.last) * this.refillPerMs);
    bucket.last = now;

    // Re-insert so Map order is least-recently-used first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (!existing && this.buckets.size > this.maxKeys) this.evict(now);

    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private evict(now: number): void {
    // Buckets that have been idle long enough to be full again carry no state.
    const fullAfterMs = this.refillPerMs > 0 ? this.capacity / this.refillPerMs : Infinity;
    for (const [key, b] of this.buckets) {
      if (now - b.last >= fullAfterMs) this.buckets.delete(key);
      if (this.buckets.size <= this.maxKeys) return;
    }
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      if (this.buckets.size <= this.maxKeys) return;
    }
  }
}

/** `perMinute` requests a minute, with bursts up to `burst`. */
export function perMinute(perMinute: number, burst: number, maxKeys?: number): RateLimiter {
  return new RateLimiter({ capacity: burst, refillPerMs: perMinute / 60_000, maxKeys });
}
