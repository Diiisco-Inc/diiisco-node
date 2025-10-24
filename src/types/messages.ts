export interface QuoteRequestPayload {
  model: string;
  inputs: any; // TODO: Define a more specific type for inputs
}

export interface QuoteRequest {
  role: "quote-request";
  from: string;
  paymentSourceAddr: string;
  timestamp: number;
  id: string;
  payload: QuoteRequestPayload;
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
  id: string;
  paymentSourceAddr: string;
  payload: {
    quote: QuoteResponsePayload;
    signature: string;
    [key: string]: any; // Allow other properties from original payload
  };
}

export interface QuoteAcceptedPayload {
  [key: string]: any; // Allow other properties from original payload
}

export interface QuoteAccepted {
  role: "quote-accepted";
  timestamp: number;
  id: string;
  paymentSourceAddr: string;
  payload: QuoteAcceptedPayload;
}

export interface InferenceResponsePayload {
  completion: any; // TODO: Define a more specific type for completion
  [key: string]: any; // Allow other properties from original payload
}

export interface InferenceResponse {
  role: "inference-response";
  timestamp: number;
  id: string;
  paymentSourceAddr: string;
  payload: InferenceResponsePayload;
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