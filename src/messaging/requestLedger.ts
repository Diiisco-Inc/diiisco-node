import { ExpiringMap } from '../utils/expiringMap';

/**
 * The provider a request was handed to: who we sent the prompt to, and so who
 * is allowed to ask us for money or hand back the answer.
 */
export interface SelectedProvider {
  /**
   * The provider's peer id as the transport authenticated it on its quote. This
   * is the identity. A wallet address cannot be: several nodes may share one.
   */
  peerId: string;
  /** The wallet that signed the quote — where the payment is to be sent. */
  payTo: string;
}

interface Entry {
  /** Absent while quotes are still being collected; set once a provider is chosen. */
  provider?: SelectedProvider;
  signed: boolean;
}

/**
 * Requester-side record of the requests this node has sent out and to whom.
 *
 * Request ids travel in the clear on a broadcast `quote-request`, and a peer id
 * is public, so any peer can address a well-formed message to us about any
 * request. The ledger is what turns "a message about request X" into "a message
 * from the provider we chose for request X": `contract-created`,
 * `inference-response` and `inference-failed` are honoured only when the
 * transport-authenticated sender is the recorded provider. Before that, the
 * ledger also knows which auctions are still collecting quotes, so a
 * `quote-response` for a request that is not (or is no longer) open is dropped.
 */
export class RequestLedger {
  private entries = new ExpiringMap<string, Entry>();

  /** Record that this node has put request `id` out for quotes. Kept until `release`d or `ttlMs` passes. */
  open(id: string, ttlMs: number): void {
    this.entries.set(id, { signed: false }, ttlMs);
  }

  /** True while `id` is an auction of ours that has not yet chosen a provider. */
  isCollectingQuotes(id: string): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && entry.provider === undefined;
  }

  /** Record the provider chosen for `id`, which closes its auction. */
  select(id: string, provider: SelectedProvider, ttlMs: number): void {
    this.entries.set(id, { provider: { ...provider }, signed: false }, ttlMs);
  }

  /** The provider chosen for `id`, or `undefined` if none (never ours, finished, or expired). */
  providerFor(id: string): SelectedProvider | undefined {
    const provider = this.entries.get(id)?.provider;
    return provider ? { ...provider } : undefined;
  }

  /** True only if `peerId` is the provider chosen for `id`. */
  isSelectedProvider(id: string, peerId: string): boolean {
    return this.entries.get(id)?.provider?.peerId === peerId;
  }

  /**
   * Claim the one payment this request may make. Returns `false` if it was
   * already claimed, so a repeated `contract-created` cannot sign twice.
   */
  claimPayment(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.provider || entry.signed) return false;
    entry.signed = true;
    return true;
  }

  /** Give the claim back — `pay()` failed before anything was signed or sent. */
  unclaimPayment(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.signed = false;
  }

  release(id: string): void {
    this.entries.delete(id);
  }
}
