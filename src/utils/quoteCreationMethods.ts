import environment from "../environment/environment";
import { QuoteRequest } from "../types/messages";
import { RawQuote } from "../types/quotes";
import { OpenAIInferenceModel } from "./models";

// Resolve the per-1M token rate for a given model.
// Prefers chargePer1MTokens; falls back to chargePer1KTokens (converted to per-1M).
function getRatePer1M(model: string): number {
  const per1M = environment.models.chargePer1MTokens;
  if (per1M) {
    return per1M[model] || per1M.default || 0.001;
  }
  const per1K = environment.models.chargePer1KTokens;
  if (per1K) {
    return (per1K[model] || per1K.default || 0.000001) * 1000;
  }
  return 0.001;
}

// Create Quote from Input Tokens ONLY
export async function createQuoteFromInputTokens(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  console.log("Creating quote from input tokens...");
  const tokens: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
  const rate = getRatePer1M(quoteRequestMsg.payload.model);

  const price = parseFloat(((tokens / 1_000_000) * rate).toFixed(6));

  return {
    price,
    rate,
    tokens
  };
}

//Create Quote from Multiple of Input Tokens
export async function createQuoteFromMultipleOfInputTokens(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  const tokens: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
  const rate = getRatePer1M(quoteRequestMsg.payload.model);

  const price = parseFloat(((tokens / 1_000_000) * rate).toFixed(6)) * 2; // Price the quote at two times the size of the input tokens

  return {
    price,
    rate,
    tokens
  };
}

// Create Quote from Output Tokens ONLY
export async function createQuoteFromOutputTokens(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  const tokens: number = (await model.getResponse(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs)).usage?.total_tokens || 1;
  const rate = getRatePer1M(quoteRequestMsg.payload.model);

  const price = parseFloat(((tokens / 1_000_000) * rate).toFixed(6));

  return {
    price,
    rate,
    tokens
  };
}

// Create Quote from Fixed price of $0.01
export async function createQuoteFromFixedPrice(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  const tokens: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
  const rate = getRatePer1M(quoteRequestMsg.payload.model);

  const price = 0.01; // Fixed price of $0.01 for any request

  return {
    price,
    rate,
    tokens
  };
}
