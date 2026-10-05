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

interface Entry extends SelectedProvider {
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
 * transport-authenticated sender is the recorded provider.
 */
export class RequestLedger {
  private entries = new ExpiringMap<string, Entry>();

  /** Record the provider chosen for `id`. Kept until `release`d or `ttlMs` passes. */
  select(id: string, provider: SelectedProvider, ttlMs: number): void {
    this.entries.set(id, { ...provider, signed: false }, ttlMs);
  }

  /** The provider chosen for `id`, or `undefined` if none (never ours, finished, or expired). */
  providerFor(id: string): SelectedProvider | undefined {
    const entry = this.entries.get(id);
    return entry ? { peerId: entry.peerId, payTo: entry.payTo } : undefined;
  }

  /** True only if `peerId` is the provider chosen for `id`. */
  isSelectedProvider(id: string, peerId: string): boolean {
    return this.entries.get(id)?.peerId === peerId;
  }

  /**
   * Claim the one payment this request may make. Returns `false` if it was
   * already claimed, so a repeated `contract-created` cannot sign twice.
   */
  claimPayment(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.signed) return false;
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
