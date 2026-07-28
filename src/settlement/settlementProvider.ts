import { Address } from "algosdk";
import algorand from "../utils/algorand";

/**
 * Settlement abstraction. Settlement was previously inlined in the four
 * `MessageProcessor` handlers against the concrete `algorand` class; this seam
 * lets escrow and x402 coexist (negotiated per quote) and lets escrow be
 * removed at release by simply unregistering its provider.
 */
export type SettlementMethod = "escrow" | "x402";

/** Opaque payload attached to `contract-created` (provider → requester). Escrow carries none — on-chain state is the source of truth. */
export interface PaymentRequest {
  [key: string]: any;
}

/** Opaque proof attached to `contract-signed` (requester → provider). Escrow carries none. */
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
  /** Turn an accepted quote into a payment request. Escrow: on-chain `createQuote`. */
  createPaymentRequest(args: {
    quoteId: string;
    customerAddress: string;
    amount: bigint; // micro-USDC
  }): Promise<PaymentRequest>;

  /** Confirm the requester has paid before serving. Escrow: `verifyQuoteFunded`. */
  verifyPayment(args: {
    quoteId: string;
    expectedAmount: bigint;
    evidence: PaymentEvidence;
  }): Promise<VerifyResult>;

  /** Finalize settlement. Escrow: no-op (the requester completes via `complete`). */
  settle(args: { quoteId: string; providerAddress: Address }): Promise<void>;

  // --- Requester side ---
  /** Satisfy a payment request. Escrow: `fundQuote`. */
  pay(args: {
    quoteId: string;
    amount: bigint;
    request: PaymentRequest;
  }): Promise<PaymentEvidence>;

  /** Finalize on the requester side. Escrow: `completeQuote`; x402: no-op (provider settles). */
  complete(args: { quoteId: string; providerAddress: Address }): Promise<void>;
}

/**
 * Escrow settlement — wraps the existing `algorand` methods verbatim. Behavior
 * of the original inlined flow is preserved; this is a pure refactor.
 */
export class EscrowSettlement implements SettlementProvider {
  readonly method = "escrow" as const;

  constructor(private algo: algorand) {}

  async createPaymentRequest(args: {
    quoteId: string;
    customerAddress: string;
    amount: bigint;
  }): Promise<PaymentRequest> {
    await this.algo.createQuote({
      quoteId: args.quoteId,
      customerAddress: args.customerAddress,
      usdcAmount: args.amount,
    });
    return {};
  }

  async verifyPayment(args: {
    quoteId: string;
    expectedAmount: bigint;
  }): Promise<VerifyResult> {
    const funded = await this.algo.verifyQuoteFunded(args.quoteId);
    return {
      ok: funded.funded !== 0n && funded.usdcAmount >= args.expectedAmount,
      amount: funded.usdcAmount,
    };
  }

  async settle(): Promise<void> {
    // No-op: under escrow the requester finalizes via `complete` (completeQuote).
  }

  async pay(args: { quoteId: string; amount: bigint }): Promise<PaymentEvidence> {
    await this.algo.fundQuote({ quoteId: args.quoteId, usdcAmount: args.amount });
    return {};
  }

  async complete(args: { quoteId: string; providerAddress: Address }): Promise<void> {
    await this.algo.completeQuote({ quoteId: args.quoteId, provider: args.providerAddress });
  }
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
