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
 * signed payment authorization. x402: the `PaymentPayload`. It echoes the
 * requirements the requester paid against, but that echo is the requester's
 * word — the provider verifies and settles against the requirements it stored
 * when it issued the challenge, never against the echo.
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

  /**
   * Confirm the requester has paid before serving. `expected` is the request
   * this node issued (what `createPaymentRequest` returned), kept by the caller;
   * the evidence must satisfy exactly that. x402: facilitator `verify`.
   */
  verifyPayment(args: {
    quoteId: string;
    expected: PaymentRequest;
    evidence: PaymentEvidence;
  }): Promise<VerifyResult>;

  /**
   * Finalize settlement, provider-side and off the critical path, against the
   * request this node issued. x402: facilitator `settle`.
   */
  settle(args: { quoteId: string; expected: PaymentRequest; evidence: PaymentEvidence }): Promise<SettlementResult>;

  // --- Requester side ---
  /**
   * Whether a payment request is one this node should ever sign: the right
   * asset on the right network, payable to `payTo` (the wallet of the provider
   * whose quote was accepted). Returns the reason it is not, or `null`.
   */
  checkRequest(request: PaymentRequest, payTo: string): string | null;

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
