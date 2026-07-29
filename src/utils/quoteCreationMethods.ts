import environment from "../environment/environment";
import { QuoteRequest } from "../types/messages";
import { RawQuote } from "../types/quotes";
import { TokenRate } from "../environment/environment.types";
import { OpenAIInferenceModel } from "./models";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

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

// Output-token cap used to size maxCharge: the request's max_tokens if given,
// else the configured default. Bounds the ceiling for open-ended requests.
function getMaxOutputTokens(quoteRequestMsg: QuoteRequest): number {
  const requested = (quoteRequestMsg.payload as any).max_tokens;
  if (typeof requested === "number" && requested > 0) return requested;
  return environment.quoteEngine.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

// Price a completed inference from its real token usage, capped at maxCharge.
// Used at settlement time (x402): the provider knows actual usage before it
// issues the payment challenge, so it charges min(actualPrice, maxCharge).
export function priceFromUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  rates: TokenRates,
  maxCharge: number
): number {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const actual = parseFloat(
    ((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output).toFixed(6)
  );
  return Math.min(actual, maxCharge);
}

// Assemble a RawQuote from an input-token count and a maxCharge (the ceiling),
// filling the split-pricing fields consistently for all creation strategies.
function buildQuote(inputTokens: number, rates: TokenRates, maxOutputTokens: number, maxCharge: number): RawQuote {
  return {
    price: maxCharge,      // escrow / legacy call sites read this
    rate: rates.input,     // legacy per-1M rate
    tokens: inputTokens,
    pricePerInputToken1M: rates.input,
    pricePerOutputToken1M: rates.output,
    maxOutputTokens,
    maxCharge,
  };
}

/**
 * The default (and only built-in) quote creation strategy. Prices a request at
 * the standard ceiling: input cost + capped output cost, using the per-model
 * input/output rates from config.
 *
 * Providers can supply their own `quoteEngine.quoteCreationFunction` with this
 * same signature to price dynamically (e.g. surge pricing by load) — it just
 * needs to return a `RawQuote`.
 */
export async function createStandardQuote(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  const inputTokens: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
  const rates = getRatesPer1M(quoteRequestMsg.payload.model);
  const maxOutputTokens = getMaxOutputTokens(quoteRequestMsg);

  const maxCharge = parseFloat(
    ((inputTokens / 1_000_000) * rates.input + (maxOutputTokens / 1_000_000) * rates.output).toFixed(6)
  );

  return buildQuote(inputTokens, rates, maxOutputTokens, maxCharge);
}
