import { OpenAIInferenceModel } from "../utils/models";
import { QuoteRequest } from "./messages";

export interface RawQuote {
  price: number;
  rate: number;
  tokens: number;
}

export type QuoteCreationFunction = (quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel) => Promise<RawQuote | null>;