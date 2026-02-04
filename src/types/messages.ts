import { Model } from "openai/resources/models";

export interface QuoteRequestPayload {
  model: string;
  inputs: any; // TODO: Define a more specific type for inputs
}

export interface QuoteRequest {
  role: "quote-request";
  from: string;
  fromWalletAddr: string;
  timestamp: number;
  id: string;
  payload: QuoteRequestPayload;
  signature?: string;
}

export interface QuoteResponsePayload {
  model: string;
  inputCount: number;
  tokenCount: number;
  pricePer1M: number;
  totalPrice: number;
  addr: string;
}

export interface QuoteResponse {
  role: "quote-response";
  timestamp: number;
  to: string;
  id: string;
  fromWalletAddr: string;
  payload: {
    quote: QuoteResponsePayload;
    [key: string]: any; // Allow other properties from original payload
  };
  signature?: string;
}

export interface QuoteAcceptedPayload {
  [key: string]: any; // Allow other properties from original payload
}

export interface QuoteAccepted {
  role: "quote-accepted";
  to: string;
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  payload: QuoteAcceptedPayload;
  signature?: string;
}

export interface ContractCreated {
  role: "contract-created";
  to: string;
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  payload: QuoteAcceptedPayload;
  signature?: string;
}

export interface ContractSigned {
  role: "contract-signed";
  to: string;
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  payload: QuoteAcceptedPayload;
  signature?: string;
}

export interface InferenceResponsePayload {
  completion: any; // TODO: Define a more specific type for completion
  [key: string]: any; // Allow other properties from original payload
}

export interface InferenceResponse {
  role: "inference-response";
  to: string;
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  payload: InferenceResponsePayload;
  signature?: string;
}

export interface ListModelsRequest {
  role: "list-models";
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  signature?: string;
}

export interface ListModelsResponse {
  role: "list-models-response";
  timestamp: number;
  id: string;
  to: string;
  fromWalletAddr: string;
  payload: {
    models: Model[];
  };
  signature?: string;
}

export type PubSubMessage = QuoteRequest | QuoteResponse | QuoteAccepted | ContractCreated | ContractSigned | InferenceResponse | ListModelsRequest | ListModelsResponse;

export interface QuoteEvent {
  msg: QuoteResponse;
  from: string;
}

export interface QuoteQueueEntry {
  quotes: QuoteEvent[];
  timeout: NodeJS.Timeout;
}