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
  pricePer1K: number;
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

export type PubSubMessage = QuoteRequest | QuoteResponse | QuoteAccepted | InferenceResponse;

export interface QuoteEvent {
  msg: QuoteResponse;
  from: string;
}

export interface QuoteQueueEntry {
  quotes: QuoteEvent[];
  timeout: NodeJS.Timeout;
}