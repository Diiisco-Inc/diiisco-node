import { Address } from "algosdk";

/**
 * Settlement abstraction. Settlement was previously inlined in the four
 * `MessageProcessor` handlers against the concrete `algorand` class (escrow).
 * Escrow has been retired; this seam is now the integration point for x402 and
 * any future settlement method. A node with no registered provider cannot
 * settle and therefore does not quote (public network) — see `MessageProcessor`.
 */
export type SettlementMethod = "x402";

/** Opaque payload attached to `contract-created` (provider → requester). x402: payment requirements. */
export interface PaymentRequest {
  [key: string]: any;
}

/** Opaque proof attached to `contract-signed` (requester → provider). x402: proof-of-payment. */
export interface PaymentEvidence {
  [key: string]: any;
}

export interface VerifyResult {
  ok: boolean;
  amount: bigint;
}

export interface SettlementProvider {
  readonly method: SettlementMethod;

  // --- Provider side ---
  /** Turn an accepted quote into a payment request. x402: build the payment requirements. */
  createPaymentRequest(args: {
    quoteId: string;
    customerAddress: string;
    amount: bigint; // micro-USDC
  }): Promise<PaymentRequest>;

  /** Confirm the requester has paid before serving. x402: facilitator `verify`. */
  verifyPayment(args: {
    quoteId: string;
    expectedAmount: bigint;
    evidence: PaymentEvidence;
  }): Promise<VerifyResult>;

  /** Finalize settlement. x402: facilitator `settle` (submits the on-chain txn). */
  settle(args: { quoteId: string; providerAddress: Address }): Promise<void>;

  // --- Requester side ---
  /** Satisfy a payment request. x402: sign the ASA transfer group. */
  pay(args: {
    quoteId: string;
    amount: bigint;
    request: PaymentRequest;
  }): Promise<PaymentEvidence>;

  /** Finalize on the requester side. x402: no-op (the provider settles). */
  complete(args: { quoteId: string; providerAddress: Address }): Promise<void>;
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
