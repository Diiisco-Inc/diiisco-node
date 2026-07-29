import { OpenAIInferenceModel } from "../utils/models";
import { QuoteRequest, QuoteCandidate } from "./messages";

export interface RawQuote {
  price: number;   // = maxCharge; retained for existing call sites (escrow reads this)
  rate: number;    // legacy per-1M rate (= input rate); retained for display/back-compat
  tokens: number;  // input token count
  // Split pricing (x402): the quote advertises per-token rates and a ceiling.
  // Actual x402 charge is metered from real usage at settlement, capped at maxCharge.
  pricePerInputToken1M: number;
  pricePerOutputToken1M: number;
  maxOutputTokens: number;
  maxCharge: number;
}

export type QuoteCreationFunction = (quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel) => Promise<RawQuote | null>;

/**
 * Picks one quote from the enriched candidates. Runs after the engine has
 * attached DSCO balance, NFD status, and response latency, so strategies can be
 * pure and synchronous (async still allowed for exotic strategies).
 */
export type QuoteSelectionFunction = (candidates: QuoteCandidate[]) => QuoteCandidate | Promise<QuoteCandidate>;