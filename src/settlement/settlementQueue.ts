import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger';

/**
 * A payment this node has accepted and released an answer for, but not yet
 * settled on-chain. The answer is already out of the door, so this record is the
 * only thing standing between the provider and having served for nothing.
 */
export interface PendingSettlement {
  quoteId: string;
  method: string;
  /** The requirements this node issued. */
  expected: unknown;
  /** The requester's signed payment. */
  evidence: unknown;
  createdAt: number;
  /** Settlement attempts made so far, across restarts. */
  attempts: number;
}

/**
 * How long an unsettled payment is worth keeping. A signed Algorand transaction
 * is valid for about 1000 rounds (roughly 50 minutes); after that it can no
 * longer be submitted, so retrying it is pointless.
 */
export const SETTLEMENT_VALIDITY_MS = 50 * 60 * 1000;

/** The most pending settlements held, so a flood of cheap requests cannot grow the file without bound. */
const MAX_PENDING = 1000;

/**
 * Payments awaiting on-chain settlement, kept in memory and — when given a
 * `path` — in a file, so a restart does not forget them. The file holds signed
 * payments, so it is written `0600`, atomically (write a temp file, then rename).
 * Without a `path` it is in-memory only (tests, library embedding).
 */
export class SettlementQueue {
  private entries = new Map<string, PendingSettlement>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    private readonly validityMs: number = SETTLEMENT_VALIDITY_MS,
  ) {}

  /** Read the file, dropping anything expired or malformed. Never throws. */
  load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      const list: unknown[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const raw of list) {
        const e = raw as Partial<PendingSettlement> | null;
        if (!e || typeof e.quoteId !== 'string' || typeof e.method !== 'string' || typeof e.createdAt !== 'number') continue;
        if (this.expired(e as PendingSettlement)) continue;
        this.entries.set(e.quoteId, {
          quoteId: e.quoteId, method: e.method, expected: e.expected, evidence: e.evidence,
          createdAt: e.createdAt, attempts: typeof e.attempts === 'number' ? e.attempts : 0,
        });
      }
      this.persist();
    } catch (err) {
      logger.warn(`⚠️ Could not read pending settlements from ${this.path}: ${(err as Error).message}`);
    }
  }

  add(entry: PendingSettlement): void {
    this.entries.set(entry.quoteId, entry);
    // Bounded: drop the oldest first if somehow full.
    while (this.entries.size > MAX_PENDING) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.persist();
  }

  get(quoteId: string): PendingSettlement | undefined {
    const e = this.entries.get(quoteId);
    if (!e) return undefined;
    if (this.expired(e)) {
      this.remove(quoteId);
      return undefined;
    }
    return e;
  }

  remove(quoteId: string): void {
    if (this.entries.delete(quoteId)) this.persist();
  }

  recordAttempt(quoteId: string): void {
    const e = this.entries.get(quoteId);
    if (!e) return;
    e.attempts += 1;
    this.persist();
  }

  /** Settlements still worth attempting. */
  list(): PendingSettlement[] {
    return [...this.entries.values()].filter((e) => !this.expired(e));
  }

  get size(): number {
    return this.list().length;
  }

  private expired(e: PendingSettlement): boolean {
    return this.now() - e.createdAt > this.validityMs;
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }), { encoding: 'utf8', mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* Windows / exotic filesystems: best effort */ }
      renameSync(tmp, this.path);
    } catch (err) {
      logger.warn(`⚠️ Could not save pending settlements to ${this.path}: ${(err as Error).message}`);
    }
  }
}
