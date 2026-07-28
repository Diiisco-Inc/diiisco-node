import algosdk from "algosdk";
import {
  ExactAvmScheme,
  toClientAvmSigner,
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_DECIMALS,
} from "@x402/avm";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
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

export interface X402SettlementConfig {
  account: algosdk.Account; // the node's own wallet (provider payTo + requester signer)
  network: "mainnet" | "testnet";
  usdcAssetId: number; // USDC ASA id for the network
  facilitatorUrl: string;
  algodUrl: string; // used by the requester to build the transfer group
  algodToken: string;
  quoteTtlSeconds?: number; // maxTimeoutSeconds on the requirements
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
  private readonly facilitator: HTTPFacilitatorClient;

  constructor(config: X402SettlementConfig) {
    this.account = config.account;
    this.caip2 = config.network === "testnet" ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2;
    this.usdcAssetId = String(config.usdcAssetId);
    this.algodUrl = config.algodUrl;
    this.algodToken = config.algodToken;
    this.quoteTtlSeconds = config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
    this.facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
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

    const res = await this.facilitator.verify(payload, requirements);
    return { ok: res.isValid, amount: paidAmount, reason: res.invalidReason };
  }

  async settle(args: { quoteId: string; evidence: PaymentEvidence }): Promise<SettlementResult> {
    const payload = args.evidence as PaymentPayload;
    const requirements = payload.accepted;
    const res = await this.facilitator.settle(payload, requirements);
    if (!res.success) {
      throw new Error(res.errorReason ?? res.errorMessage ?? "facilitator settle failed");
    }
    logger.info(`✅ x402 settled quote ${args.quoteId} — txid ${res.transaction}`);
    return {
      txid: res.transaction,
      amount: BigInt(res.amount ?? requirements.amount),
    };
  }

  // --- Requester side ---

  async pay(args: { quoteId: string; amount: bigint; request: PaymentRequest }): Promise<PaymentEvidence> {
    const requirements = args.request as PaymentRequirements;
    const signer = toClientAvmSigner(Buffer.from(this.account.sk).toString("base64"));
    const scheme = new ExactAvmScheme(signer, { algodUrl: this.algodUrl, algodToken: this.algodToken });
    const result = await scheme.createPaymentPayload(X402_VERSION, requirements);
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: result.payload,
    };
    return payload;
  }
}
