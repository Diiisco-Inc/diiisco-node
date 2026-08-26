import algosdk from "algosdk";
import {
  ExactAvmScheme,
  toClientAvmSigner,
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  USDC_DECIMALS,
  decodeTransaction,
  getTransactionId,
} from "@x402/avm";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequirements, PaymentPayload, ResourceInfo } from "@x402/core/types";
import { logger } from "../utils/logger";
import {
  SettlementProvider,
  PaymentRequest,
  PaymentEvidence,
  VerifyResult,
  SettlementResult,
} from "./settlementProvider";

const X402_VERSION = 2;
const DEFAULT_QUOTE_TTL_SECONDS = 120;

/**
 * The shared DIIISCO service identity stamped on every node's x402 payment.
 * The facilitator's Bazaar catalogs resources by `url`, so every DIIISCO node
 * advertising this same resource makes the whole network's volume aggregate
 * under one entry — DIIISCO counts as a single provider, not one per wallet.
 * This is a network-wide constant; do not vary it per node.
 */
const DIIISCO_RESOURCE: ResourceInfo = {
  url: "https://x402.diiisco.com/",
  serviceName: "DIIISCO",
  description: "DIIISCO. Algorand's decentralized AI compute network, paid per token in USDC via x402.",
  iconUrl: "https://asset.diiisco.com/diiisco-logomark.png",
  tags: ["ai", "llm", "inference", "p2p", "x402-global-challenge", "diiisco"],
};

export interface X402SettlementConfig {
  account: algosdk.Account; // the node's own wallet (provider payTo + requester signer)
  network: "mainnet" | "testnet";
  usdcAssetId: number; // USDC ASA id for the network
  facilitatorUrl: string;
  algodUrl: string; // used by the requester to build the transfer group + provider self-submit
  algodToken: string;
  algodPort?: number;
  quoteTtlSeconds?: number; // maxTimeoutSeconds on the requirements
  selfSubmitFallback?: boolean; // default true — submit the signed group to algod if the facilitator fails
}

/**
 * x402 settlement over the GoPlausible-compatible facilitator.
 *
 * The node plays both roles depending on the message it is handling:
 * - Provider: builds `PaymentRequirements` (`createPaymentRequest`), verifies the
 *   requester's signed payment off-chain (`verifyPayment` → facilitator verify),
 *   and submits it on-chain in the background (`settle` → facilitator settle).
 * - Requester: signs an ASA transfer group satisfying the requirements (`pay`).
 *
 * The `PaymentPayload` carries the accepted `PaymentRequirements` inside it, so
 * verify/settle need no per-quote state stored here.
 */
export class X402Settlement implements SettlementProvider {
  readonly method = "x402" as const;

  private readonly account: algosdk.Account;
  private readonly caip2: string;
  private readonly usdcAssetId: string;
  private readonly algodUrl: string;
  private readonly algodToken: string;
  private readonly quoteTtlSeconds: number;
  private readonly selfSubmitFallback: boolean;
  private readonly facilitator: HTTPFacilitatorClient;
  private readonly algod: algosdk.Algodv2;

  constructor(config: X402SettlementConfig) {
    this.account = config.account;
    // The facilitator matches networks on the FULL genesis-hash CAIP-2 form
    // (algorand:<base64 genesis hash>), not the library's truncated canonical id
    // — sending the truncated form fails verify with "Network not supported".
    this.caip2 = config.network === "testnet"
      ? `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`
      : `algorand:${ALGORAND_MAINNET_GENESIS_HASH}`;
    this.usdcAssetId = String(config.usdcAssetId);
    this.algodUrl = config.algodUrl;
    this.algodToken = config.algodToken;
    this.quoteTtlSeconds = config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
    this.selfSubmitFallback = config.selfSubmitFallback ?? true;
    this.facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    this.algod = new algosdk.Algodv2(config.algodToken, config.algodUrl, config.algodPort ?? 443);
  }

  // --- Provider side ---

  async createPaymentRequest(args: { quoteId: string; amount: bigint }): Promise<PaymentRequest> {
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: this.caip2 as PaymentRequirements["network"],
      asset: this.usdcAssetId,
      amount: args.amount.toString(),
      payTo: this.account.addr.toString(),
      maxTimeoutSeconds: this.quoteTtlSeconds,
      extra: { decimals: USDC_DECIMALS },
    };
    return requirements;
  }

  async verifyPayment(args: {
    quoteId: string;
    expectedAmount: bigint;
    evidence: PaymentEvidence;
  }): Promise<VerifyResult> {
    const payload = args.evidence as PaymentPayload;
    const requirements = payload?.accepted;
    if (!requirements) {
      return { ok: false, amount: 0n, reason: "missing payment requirements" };
    }

    // Guard against a requester diverting payment or inflating the charge: the
    // payment must be to us and no more than the amount we asked for.
    if (requirements.payTo !== this.account.addr.toString()) {
      return { ok: false, amount: 0n, reason: "payTo does not match provider" };
    }
    const paidAmount = BigInt(requirements.amount);
    if (paidAmount > args.expectedAmount) {
      return { ok: false, amount: paidAmount, reason: "amount exceeds quoted charge" };
    }

    // Retry only transient (thrown) facilitator errors; an `isValid: false`
    // result is a real rejection and returns immediately.
    const res = await this.withRetry(() => this.facilitator.verify(payload, requirements));
    return { ok: res.isValid, amount: paidAmount, reason: res.invalidReason };
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async settle(args: { quoteId: string; evidence: PaymentEvidence }): Promise<SettlementResult> {
    const payload = args.evidence as PaymentPayload;
    const requirements = payload.accepted;
    try {
      const res = await this.facilitator.settle(payload, requirements);
      if (!res.success) {
        throw new Error(res.errorReason ?? res.errorMessage ?? "facilitator settle failed");
      }
      logger.info(`✅ x402 settled quote ${args.quoteId} via facilitator — txid ${res.transaction}`);
      return { txid: res.transaction, amount: BigInt(res.amount ?? requirements.amount) };
    } catch (err) {
      if (!this.selfSubmitFallback) throw err;
      // The payment group is fully signed by the requester (no fee abstraction),
      // so if the facilitator is unavailable we can submit it to algod ourselves.
      logger.warn(`⚠️ Facilitator settle failed for ${args.quoteId} (${(err as Error).message}); self-submitting to algod.`);
      const txid = await this.selfSubmit(args.quoteId, payload);
      return { txid, amount: BigInt(requirements.amount) };
    }
  }

  /** No-facilitator fallback: submit the signed transaction group directly to algod. */
  private async selfSubmit(quoteId: string, payload: PaymentPayload): Promise<string> {
    const avm = payload.payload as { paymentGroup?: string[]; paymentIndex?: number };
    if (!Array.isArray(avm?.paymentGroup) || avm.paymentGroup.length === 0) {
      throw new Error("cannot self-submit: payment group is missing");
    }
    const signed = avm.paymentGroup.map((b64) => decodeTransaction(b64));
    const paymentTxn = signed[avm.paymentIndex ?? signed.length - 1] ?? signed[signed.length - 1];
    const txid = getTransactionId(paymentTxn);
    await this.algod.sendRawTransaction(signed).do();
    await algosdk.waitForConfirmation(this.algod, txid, 4);
    logger.info(`✅ x402 self-submitted quote ${quoteId} to algod — txid ${txid}`);
    return txid;
  }

  // --- Requester side ---

  async pay(args: { quoteId: string; amount: bigint; request: PaymentRequest }): Promise<PaymentEvidence> {
    const requirements = args.request as PaymentRequirements;
    const signer = toClientAvmSigner(Buffer.from(this.account.sk).toString("base64"));
    const scheme = new ExactAvmScheme(signer, { algodUrl: this.algodUrl, algodToken: this.algodToken });
    const result = await scheme.createPaymentPayload(X402_VERSION, requirements);
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      // Shared DIIISCO service identity so the facilitator's Bazaar catalogs
      // every node's payment under one resource (see DIIISCO_RESOURCE).
      resource: DIIISCO_RESOURCE,
      accepted: requirements,
      payload: result.payload,
    };
    return payload;
  }
}
