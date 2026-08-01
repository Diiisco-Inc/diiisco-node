import environment from "../environment/runtime";
import { QuoteRequest } from "../types/messages";
import { RawQuote, BudgetPlan } from "../types/quotes";
import { TokenRate } from "../environment/environment.types";
import { OpenAIInferenceModel } from "./models";

export interface TokenRates {
  input: number;
  output: number;
}

// A bare number means equal input/output rates (legacy scalar config).
function normalizeRate(rate: TokenRate): TokenRates {
  return typeof rate === "number" ? { input: rate, output: rate } : rate;
}

// Resolve the per-1M input/output token rates for a given model.
// Prefers chargePer1MTokens; falls back to chargePer1KTokens (scalar, converted to per-1M).
export function getRatesPer1M(model: string): TokenRates {
  const per1M = environment.models.chargePer1MTokens;
  if (per1M) {
    return normalizeRate(per1M[model] ?? per1M.default ?? 0.001);
  }
  const per1K = environment.models.chargePer1KTokens;
  if (per1K) {
    const rate = (per1K[model] ?? per1K.default ?? 0.000001) * 1000;
    return { input: rate, output: rate };
  }
  return { input: 0.001, output: 0.001 };
}

/**
 * Resolve the requester's `maxSpend` budget against a request (§4.2 C): decide
 * whether the provider can serve it, and how many output tokens the remaining
 * budget affords. Used both at quote time (to decide whether to quote) and at
 * inference time (to cap generation).
 *
 *   inputCost = k · r_in / 1e6
 *   don't serve if maxSpend unset, or inputCost ≥ maxSpend
 *   o = floor((maxSpend − inputCost) · 1e6 / r_out)   → don't serve if o ≤ 0
 *   outputCap = requesterMaxTokens ? min(o, requesterMaxTokens) : o
 */
export function planBudget(
  inputTokens: number,
  rates: TokenRates,
  maxSpend: number | undefined,
  requesterMaxTokens?: number
): BudgetPlan {
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  if (!maxSpend || maxSpend <= 0 || inputCost >= maxSpend) {
    return { canServe: false, inputCost, outputCap: 0 };
  }

  const remaining = maxSpend - inputCost;
  // Free-output edge: if r_out is 0 the budget doesn't bound output; fall back
  // to the requester's own cap (or unbounded — charge is inputCost ≤ maxSpend).
  let outputCap = rates.output > 0
    ? Math.floor((remaining * 1_000_000) / rates.output)
    : (requesterMaxTokens ?? Number.MAX_SAFE_INTEGER);

  if (outputCap <= 0) return { canServe: false, inputCost, outputCap: 0 };
  if (requesterMaxTokens && requesterMaxTokens > 0) outputCap = Math.min(outputCap, requesterMaxTokens);

  return { canServe: true, inputCost, outputCap };
}

// Price a completed inference from its real token usage, clamped to the
// requester's budget (§4.2 D). Used at settlement time: the provider knows the
// actual usage before it issues the payment challenge.
export function priceFromUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  rates: TokenRates,
  maxSpend: number
): number {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const actual = parseFloat(
    ((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output).toFixed(6)
  );
  return Math.min(actual, maxSpend);
}

/**
 * The default (and only built-in) quote creation strategy. Counts input tokens,
 * looks up the per-model rates, and — if the requester's `maxSpend` budget can
 * cover at least the input plus some output — returns a quote carrying the
 * rates. Returns `null` (don't quote) when the request can't be served within
 * the budget.
 *
 * Providers can supply their own `quoteEngine.quoteCreationFunction` with this
 * same signature to price dynamically (e.g. surge pricing by load).
 */
export async function createStandardQuote(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  // The requester supplies its own input-token count so the prompt content isn't
  // broadcast; the provider re-counts from the real content at accept time.
  const inputTokens: number = quoteRequestMsg.payload.inputTokenCount ?? 0;
  const rates = getRatesPer1M(quoteRequestMsg.payload.model);

  const plan = planBudget(inputTokens, rates, quoteRequestMsg.payload.maxSpend, quoteRequestMsg.payload.max_tokens);
  if (!plan.canServe) return null;

  return {
    pricePerInputToken1M: rates.input,
    pricePerOutputToken1M: rates.output,
    inputTokens,
  };
}
