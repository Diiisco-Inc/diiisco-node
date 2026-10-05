import algosdk from "algosdk";
import {
  ExactAvmScheme,
  toClientAvmSigner,
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  USDC_DECIMALS,
  decodeTransaction,
  decodeSignedTransaction,
  getTransactionId,
} from "@x402/avm";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequirements, PaymentPayload, ResourceInfo } from "@x402/core/types";
import { logger } from "../utils/logger";
import { ExpiringMap } from "../utils/expiringMap";
import {
  SettlementProvider,
  PaymentRequest,
  PaymentEvidence,
  VerifyResult,
  SettlementResult,
} from "./settlementProvider";

const X402_VERSION = 2;
const DEFAULT_QUOTE_TTL_SECONDS = 120;
// How long a payment's transaction id is remembered as spent. A signed Algorand
// transaction is only valid for ~1000 rounds (about 50 minutes), so an hour
// outlasts anything that could still be submitted.
const USED_PAYMENT_TTL_MS = 60 * 60 * 1000;

/**
 * The shared DIIISCO service identity stamped on every node's x402 payment.
 * The facilitator's Bazaar catalogs resources by `url`, so every DIIISCO node
 * advertising this same resource makes the whole network's volume aggregate
 * under one entry — DIIISCO counts as a single provider, not one per wallet.
 * This is a network-wide constant; do not vary it per node.
 */
const DIIISCO_RESOURCE: ResourceInfo = {
  url: "https://x402.diiisco.com/v1/chat/completions",
  serviceName: "DIIISCO",
  description: "DIIISCO. Algorand's decentralized AI compute network, paid per token in USDC via x402.",
  iconUrl: "https://asset.diiisco.com/diiisco-logomark-black.png",
  tags: ["ai", "llm", "inference", "p2p", "x402-global-challenge", "diiisco"],
};

/**
 * DIIISCO's **merchant** identity — who is selling, as opposed to what is sold.
 *
 * A different layer from `DIIISCO_RESOURCE` above, and easy to conflate with
 * it. The resource block describes one endpoint and is catalogued by `url`; the
 * merchant record describes the seller, is keyed by the **receiving wallet
 * address**, and spans every resource that wallet is paid for. Setting one does
 * not populate the other — the facilitator holds a merchant record per wallet
 * with `name`, `logo`, `categories` and `website` all null until this is
 * declared, even when the resource identity is already complete.
 *
 * Because every node settles from its own wallet, each node is a **separate**
 * merchant record. Without this, nodes appear in the sellers catalog as
 * anonymous wallet addresses; with it, they all read "DIIISCO".
 *
 * Undeclared, the facilitator falls back to scraping the domain (OpenGraph
 * tags, `llms.txt`, `agent-card.json`). Declaring it is how DIIISCO controls
 * its own listing. Keep in sync with `MERCHANT_INFO` in
 * `diiisco-x402/src/payment/discovery.ts` — one identity, one catalog.
 */
const DIIISCO_MERCHANT = {
  info: {
    name: "DIIISCO",
    website: "https://diiisco.com",
    logo: "https://asset.diiisco.com/diiisco-logomark-black.png",
    categories: ["ai", "llm", "inference", "p2p", "algorand"],
  },
  // JSON Schema the facilitator validates `info` against; `name` is the only
  // required field.
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      website: { type: "string" },
      logo: { type: "string" },
      categories: { type: "array", items: { type: "string" } },
    },
  },
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
 * The `PaymentPayload` echoes the requirements the requester paid against, but
 * that echo is the requester's word. The caller keeps the requirements this node
 * *issued* per quote and hands them back to `verifyPayment` and `settle`, so the
 * facilitator is only ever asked about requirements the provider wrote. The one
 * piece of state held here is the set of payment transactions already spent.
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
  // Payment transactions already accepted. The requirements carry no quote id,
  // so without this one signed transfer could unlock two equal-priced quotes.
  private readonly usedPayments = new ExpiringMap<string, true>();

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
      extra: { decimals: USDC_DECIMALS, tag: "x402-global-challenge" },
    };
    return requirements;
  }

  async verifyPayment(args: {
    quoteId: string;
    expected: PaymentRequest;
    evidence: PaymentEvidence;
  }): Promise<VerifyResult> {
    const payload = args.evidence as PaymentPayload;
    const expected = args.expected as PaymentRequirements;
    const accepted = payload?.accepted;
    if (!accepted) {
      return { ok: false, amount: 0n, reason: "missing payment requirements" };
    }

    // The requester echoes what it paid against. It has to be exactly what we
    // issued: any other asset, network, amount or payee is a different deal.
    const mismatch = requirementsMismatch(expected, accepted);
    if (mismatch) {
      return { ok: false, amount: 0n, reason: `payment does not match the issued requirements (${mismatch})` };
    }
    const paidAmount = BigInt(expected.amount);

    // One payment, one quote. Reserve the transaction id before the (async)
    // facilitator call so two concurrent contracts cannot both claim it.
    const txid = paymentTransactionId(payload);
    if (!txid) {
      return { ok: false, amount: paidAmount, reason: "payment group is missing" };
    }
    if (this.usedPayments.has(txid)) {
      return { ok: false, amount: paidAmount, reason: "payment transaction already used" };
    }
    this.usedPayments.set(txid, true, USED_PAYMENT_TTL_MS);

    try {
      // Retry only transient (thrown) facilitator errors; an `isValid: false`
      // result is a real rejection and returns immediately. The facilitator is
      // given OUR requirements, not the requester's echo.
      const res = await this.withRetry(() => this.facilitator.verify(payload, expected));
      if (!res.isValid) this.usedPayments.delete(txid);
      return { ok: res.isValid, amount: paidAmount, reason: res.invalidReason };
    } catch (err) {
      this.usedPayments.delete(txid);
      throw err;
    }
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

  async settle(args: { quoteId: string; expected: PaymentRequest; evidence: PaymentEvidence }): Promise<SettlementResult> {
    const payload = args.evidence as PaymentPayload;
    const requirements = args.expected as PaymentRequirements;
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
      const txid = await this.selfSubmit(args.quoteId, payload, requirements);
      return { txid, amount: BigInt(requirements.amount) };
    }
  }

  /** No-facilitator fallback: submit the signed transaction group directly to algod. */
  private async selfSubmit(quoteId: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<string> {
    const avm = payload.payload as { paymentGroup?: string[]; paymentIndex?: number };
    if (!Array.isArray(avm?.paymentGroup) || avm.paymentGroup.length === 0) {
      throw new Error("cannot self-submit: payment group is missing");
    }
    const paymentIndex = avm.paymentIndex ?? avm.paymentGroup.length - 1;
    // The facilitator is not here to check the transfer, so check it ourselves:
    // submitting a group whose transfer is not what we issued would settle the
    // wrong deal on-chain.
    const problem = paymentTransferMismatch(avm.paymentGroup[paymentIndex], requirements);
    if (problem) throw new Error(`cannot self-submit: ${problem}`);

    const signed = avm.paymentGroup.map((b64) => decodeTransaction(b64));
    const paymentTxn = signed[paymentIndex] ?? signed[signed.length - 1];
    const txid = getTransactionId(paymentTxn);
    await this.algod.sendRawTransaction(signed).do();
    await algosdk.waitForConfirmation(this.algod, txid, 4);
    logger.info(`✅ x402 self-submitted quote ${quoteId} to algod — txid ${txid}`);
    return txid;
  }

  // --- Requester side ---

  checkRequest(request: PaymentRequest, payTo: string): string | null {
    const r = request as Partial<PaymentRequirements> | undefined;
    if (!r || typeof r !== "object") return "no payment requirements";
    if (r.scheme !== "exact") return `unsupported scheme "${String(r.scheme)}"`;
    if (r.network !== this.caip2) return `wrong network "${String(r.network)}"`;
    if (String(r.asset) !== this.usdcAssetId) return `wrong asset "${String(r.asset)}" (expected USDC ${this.usdcAssetId})`;
    if (r.payTo !== payTo) return "payTo is not the selected provider's wallet";
    if (typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) return "amount is not a base-unit integer";
    // This node pays its own fees. A fee payer in the requirements would add an
    // unsigned third-party transaction to the group we sign.
    if ((r.extra as any)?.feePayer) return "fee payer sponsorship is not supported";
    return null;
  }

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
      // Seller identity for the merchant catalog, attributed to the payee —
      // `requirements.payTo`, i.e. the provider node being paid. Both ends of a
      // DIIISCO settlement are DIIISCO, so this reads "DIIISCO" whichever side
      // the facilitator credits it to (see DIIISCO_MERCHANT).
      extensions: { "x402-merchant": DIIISCO_MERCHANT },
      accepted: requirements,
      payload: result.payload,
    };
    return payload;
  }
}

/**
 * Why the requester's echoed requirements differ from the ones this node
 * issued, or `null` when they are the same deal. Compared field by field and
 * as strings, never by object identity: the echo has been through msgpack, so
 * key order and number/string forms are not preserved.
 */
export function requirementsMismatch(expected: PaymentRequirements, accepted: PaymentRequirements): string | null {
  for (const field of ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"] as const) {
    if (String(expected[field]) !== String((accepted as any)[field])) return field;
  }
  if (stableJson(expected.extra ?? {}) !== stableJson(accepted.extra ?? {})) return "extra";
  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The transaction id of the payment transfer inside an x402 AVM payload, or `null` if malformed. */
export function paymentTransactionId(payload: PaymentPayload): string | null {
  try {
    const avm = payload?.payload as { paymentGroup?: string[]; paymentIndex?: number } | undefined;
    if (!Array.isArray(avm?.paymentGroup) || avm.paymentGroup.length === 0) return null;
    const entry = avm.paymentGroup[avm.paymentIndex ?? avm.paymentGroup.length - 1];
    return typeof entry === "string" ? getTransactionId(decodeTransaction(entry)) : null;
  } catch {
    return null;
  }
}

/** Why a signed payment transaction does not pay what `requirements` ask for, or `null` if it does. */
function paymentTransferMismatch(encoded: string | undefined, requirements: PaymentRequirements): string | null {
  try {
    if (typeof encoded !== "string") return "payment transaction is missing";
    const transfer = (decodeSignedTransaction(encoded).txn as any)?.assetTransfer;
    if (!transfer) return "payment is not an asset transfer";
    if (String(transfer.assetId) !== String(requirements.asset)) return "payment asset differs from the issued requirements";
    if (String(transfer.amount) !== String(requirements.amount)) return "payment amount differs from the issued requirements";
    if (String(transfer.receiver) !== String(requirements.payTo)) return "payment receiver differs from the issued requirements";
    return null;
  } catch {
    return "payment transaction could not be decoded";
  }
}
