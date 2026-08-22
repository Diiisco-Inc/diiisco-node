/**
 * Settlement abstraction. Settlement was previously inlined in the four
 * `MessageProcessor` handlers against the concrete `algorand` class (escrow).
 * Escrow has been retired; this seam is now the integration point for x402 and
 * any future settlement method. A node with no registered provider cannot
 * settle and therefore does not quote (public network) — see `MessageProcessor`.
 */
export type SettlementMethod = "x402";

/**
 * Payment requirements attached to `contract-created` (provider → requester):
 * what to pay, in which asset, to whom. x402: the `PaymentRequirements` object.
 */
export interface PaymentRequest {
  [key: string]: any;
}

/**
 * Proof-of-payment attached to `contract-signed` (requester → provider): the
 * signed payment authorization. x402: the `PaymentPayload` (carries the accepted
 * requirements inside it, so verify/settle need no separate state).
 */
export interface PaymentEvidence {
  [key: string]: any;
}

export interface VerifyResult {
  ok: boolean;
  amount: bigint;
  reason?: string;
}

export interface SettlementResult {
  txid?: string;
  amount?: bigint;
}

export interface SettlementProvider {
  readonly method: SettlementMethod;

  // --- Provider side ---
  /** Turn an accepted quote into a payment request. x402: build the payment requirements. */
  createPaymentRequest(args: {
    quoteId: string;
    amount: bigint; // atomic units (micro-USDC)
  }): Promise<PaymentRequest>;

  /** Confirm the requester has paid before serving. x402: facilitator `verify`. */
  verifyPayment(args: {
    quoteId: string;
    expectedAmount: bigint;
    evidence: PaymentEvidence;
  }): Promise<VerifyResult>;

  /** Finalize settlement, provider-side and off the critical path. x402: facilitator `settle`. */
  settle(args: { quoteId: string; evidence: PaymentEvidence }): Promise<SettlementResult>;

  // --- Requester side ---
  /** Satisfy a payment request. x402: sign the ASA transfer group. */
  pay(args: {
    quoteId: string;
    amount: bigint;
    request: PaymentRequest;
  }): Promise<PaymentEvidence>;
}

/** Registry of available settlement providers, keyed by method. */
export class SettlementRegistry {
  private providers = new Map<SettlementMethod, SettlementProvider>();

  register(provider: SettlementProvider): void {
    this.providers.set(provider.method, provider);
  }

  get(method: SettlementMethod): SettlementProvider {
    const provider = this.providers.get(method);
    if (!provider) throw new Error(`No settlement provider registered for method '${method}'`);
    return provider;
  }

  has(method: SettlementMethod): boolean {
    return this.providers.has(method);
  }

  methods(): SettlementMethod[] {
    return [...this.providers.keys()];
  }
}
