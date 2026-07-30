import { Model } from "openai/resources/models";
import { NodeProfile } from "./profile";

export interface QuoteRequestPayload {
  model: string;
  inputs: any; // TODO: Define a more specific type for inputs
  maxSpend?: number;   // requester's per-request budget in USDC (§4.2); providers budget against it
  max_tokens?: number; // optional requester output cap, forwarded to the model runtime
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
  tokenCount: number;              // input tokens counted by the provider (k)
  addr: string;
  // Per-token rates: the provider's signed price commitment (§4.2). There is no
  // provider-set charge ceiling — the requester's own `maxSpend` bounds the cost.
  pricePerInputToken1M: number;
  pricePerOutputToken1M: number;
  settlementMethods?: 'x402'[];
  assetId?: number;
  quoteExpiresAt?: number;
  requestTimestamp?: number;       // echo of the quote-request timestamp, for measuring response latency
  nfd?: string;                    // provider's NFD name, so the requester can verify it
  providerPeerId?: string;         // provider's own peer id (NFD verification needs it; GossipSub `from` may be a relay)
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

export interface NetworkNode {
  peerId: string;
  walletAddr: string;
  nfd?: string;
  displayName?: string;
}

export interface ListNetworkRequest {
  role: "list-network";
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  signature?: string;
}

export interface ListNetworkResponse {
  role: "list-network-response";
  timestamp: number;
  id: string;
  to: string;
  fromWalletAddr: string;
  payload: {
    node: NetworkNode;
  };
  signature?: string;
}

export interface NodeProfileRequest {
  role: "node-profile";
  to: string;
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  payload: {
    peerId: string;
  };
  signature?: string;
}

export interface NodeProfileResponse {
  role: "node-profile-response";
  to: string;
  timestamp: number;
  id: string;
  fromWalletAddr: string;
  payload: {
    profile: NodeProfile;
  };
  signature?: string;
}

export type PubSubMessage = (
  | QuoteRequest
  | QuoteResponse
  | QuoteAccepted
  | ContractCreated
  | ContractSigned
  | InferenceResponse
  | ListModelsRequest
  | ListModelsResponse
  | ListNetworkRequest
  | ListNetworkResponse
  | NodeProfileRequest
  | NodeProfileResponse
) & {
  /**
   * Sender's current libp2p multiaddrs (including relay-circuit addresses),
   * stamped onto every message at sign time. Lets peers dial the sender over a
   * relay without a DHT lookup — NATed peers are DHT clients and so are not
   * resolvable via findPeer. Part of the signed payload, so it is authenticated.
   */
  multiaddrs?: string[];
};

export interface QuoteEvent {
  msg: QuoteResponse;
  from: string;
  receivedAt: number; // when this node received the quote (for response-latency)
}

export interface QuoteQueueEntry {
  quotes: QuoteEvent[];
  timeout: NodeJS.Timeout;
}

/**
 * A quote enriched with everything a selection strategy needs, computed once by
 * the quote engine before selection so the strategies stay pure and synchronous.
 */
export interface QuoteCandidate {
  quote: QuoteResponsePayload;   // quote attributes (per-input/output token rates, model, …)
  from: string;                  // provider peer id
  fromWalletAddr: string;        // provider wallet address
  dscoBalance: bigint;           // DSCO held by the provider wallet (0 if none / local mode)
  nfdAuthenticated: boolean;     // provider wallet has a verified NFD
  responseLatencyMs: number;     // how quickly the quote arrived after the request was issued
  msg: QuoteResponse;            // raw response (needed to build quote-accepted)
}