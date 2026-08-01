import { OpenAIInferenceModel } from "../utils/models";
import { QuoteRequest, QuoteCandidate } from "./messages";

/**
 * A provider's quote for a request. The provider commits to per-token rates
 * (the signed price); the actual charge is metered from real usage at
 * settlement and bounded by the requester's `maxSpend` (§4.2). There is no
 * provider-set price ceiling — a provider-owned ceiling protects no one.
 */
export interface RawQuote {
  pricePerInputToken1M: number;
  pricePerOutputToken1M: number;
  inputTokens: number;   // counted by the provider (k)
}

/**
 * The requester's `maxSpend` budget resolved against a request: whether the
 * provider can serve it, and the output-token cap the budget affords.
 */
export interface BudgetPlan {
  canServe: boolean;
  inputCost: number;   // USDC (k · r_in)
  outputCap: number;   // affordable output tokens (o), already min'd with any requester max_tokens
}

export type QuoteCreationFunction = (quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel) => Promise<RawQuote | null>;

/**
 * Picks one quote from the enriched candidates. Runs after the engine has
 * attached DSCO balance, NFD status, and response latency, so strategies can be
 * pure and synchronous (async still allowed for exotic strategies).
 */
export type QuoteSelectionFunction = (candidates: QuoteCandidate[]) => QuoteCandidate | Promise<QuoteCandidate>;