/**
 * A Map whose entries expire. Used for the short-lived state the payment flow
 * keeps per request (issued quotes, issued contracts, used payments): it must
 * not grow without bound, because its keys are chosen by remote peers.
 *
 * Expiry is lazy — an expired entry is invisible to every read — plus a sweep
 * piggybacked on `set`, so there are no timers to leak or `unref`.
 */
export class ExpiringMap<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>();
  private lastSweep = Date.now();

  constructor(private readonly sweepEveryMs = 30_000) {}

  set(key: K, value: V, ttlMs: number): void {
    this.sweepIfDue();
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /** Read and remove in one step — for state that may be used exactly once. */
  take(key: K): V | undefined {
    const value = this.get(key);
    this.entries.delete(key);
    return value;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweepIfDue(): void {
    if (Date.now() - this.lastSweep >= this.sweepEveryMs) this.sweep();
  }

  private sweep(): void {
    const now = Date.now();
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
