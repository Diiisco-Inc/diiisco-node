import environment from "../environment/environment";
import { QuoteRequest } from "../types/messages";
import { RawQuote } from "../types/quotes";
import { OpenAIInferenceModel } from "./models";

// Create Quote from Input Tokens ONLY
export async function createQuoteFromInputTokens(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  console.log("Creating quote from input tokens...");
  const tokens: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
  const rate = environment.models.chargePer1KTokens[quoteRequestMsg.payload.model] || environment.models.chargePer1KTokens.default || 0.000001;

  const price = parseFloat(((tokens / 1000) * rate).toFixed(6));

  return {
    price,
    rate,
    tokens
  };
}

//Create Quote from Multiple of Input Tokens
export async function createQuoteFromMultipleOfInputTokens(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  const tokens: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
  const rate = environment.models.chargePer1KTokens[quoteRequestMsg.payload.model] || environment.models.chargePer1KTokens.default || 0.000001;

  const price = parseFloat(((tokens / 1000) * rate).toFixed(6)) * 2; // Price the quote at two times the size of the input tokens

  return {
    price,
    rate,
    tokens
  };
}

// Create Quote from Output Tokens ONLY
export async function createQuoteFromOutputTokens(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  const tokens: number = (await model.getResponse(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs)).usage?.total_tokens || 1;
  const rate = environment.models.chargePer1KTokens[quoteRequestMsg.payload.model] || environment.models.chargePer1KTokens.default || 0.000001;

  const price = parseFloat(((tokens / 1000) * rate).toFixed(6));

  return {
    price,
    rate,
    tokens
  };
}

// Create Quote from Fixed price of $0.01
export async function createQuoteFromFixedPrice(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
  const tokens: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
  const rate = environment.models.chargePer1KTokens[quoteRequestMsg.payload.model] || environment.models.chargePer1KTokens.default || 0.000001;

  const price = 0.01; // Fixed price of $0.01for any request

  return {
    price,
    rate,
    tokens
  };
}