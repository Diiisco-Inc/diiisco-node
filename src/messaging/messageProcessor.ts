import { EventEmitter } from 'events';
import algorand from "../utils/algorand";
import environment from "../environment/runtime";
import { OpenAIInferenceModel, pickGenerationParams, countInputTokens } from "../utils/models";
import { ModelAvailability } from "../utils/modelAvailability";
import type { ModelKind } from "../types/models";
import { countSystemOneInputTokens, normalizeUsage, validateSystemOneRequest } from "../utils/systemOne";
import quoteEngine from "../utils/quoteEngine";
import {
  PubSubMessage,
  QuoteRequest,
  QuoteResponse,
  QuoteAccepted,
  InferenceResponse,
  InferenceFailed,
  InferenceFailureReason,
  ContractSigned,
  ContractCreated,
  ListModelsRequest,
  ListModelsResponse,
  ListNetworkRequest,
  ListNetworkResponse,
  NetworkNode,
  NodeProfileRequest,
  NodeProfileResponse,
} from "../types/messages";
import { buildOwnProfile } from "../utils/nodeProfile";
import { nodeStats } from "../utils/nodeStats";
import { logger } from '../utils/logger';
import { Environment } from "../environment/environment.types";
import diiiscoAssets from "../utils/diiiscoAssets";
import { verifyNFD } from '../utils/algorand';
import { RawQuote } from "../types/quotes";
import { priceFromUsage, planBudget } from "../utils/quoteCreationMethods";
import { MessageRouter } from './messageRouter';
import { SpeculativeInferenceCache } from './speculativeInferenceCache';
import { SettlementRegistry, SettlementProvider, SettlementMethod, PaymentRequest } from '../settlement/settlementProvider';
import { X402Settlement } from '../settlement/x402Settlement';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { ExpiringMap } from '../utils/expiringMap';
import { RequestLedger } from './requestLedger';

const QUOTE_TTL_MS = 120_000;      // validity window advertised on quotes (x402 requires one)
const COMPLETION_TTL_MS = 120_000; // how long a withheld completion is held awaiting payment
const MIN_CHARGE = 0.000001;       // 1 µUSDC — x402/facilitator reject a zero-value transfer

/**
 * What a provider remembers about a quote it issued. A `quote-accepted` is only
 * honoured against this record: the requester's own copy of the rates, model or
 * budget is its word, not ours.
 */
interface IssuedQuote {
  model: string;
  kind?: 'systemone';
  rates: { input: number; output: number };
  maxSpend?: number;
}

/**
 * A payment challenge this provider issued, and the answer withheld until it is
 * paid. Single-use: `contract-signed` consumes it.
 */
interface IssuedContract {
  requirements: PaymentRequest;
  completion: any;
}

/**
 * Per-request state is keyed by the peer id **and** the request id. The peer id
 * is the identity: it is authenticated by the transport, whereas a wallet
 * address can be shared by several nodes, and a request id is picked by the
 * requester and visible to everyone. Keying on both means a stranger can
 * neither read nor burn another peer's entry by reusing its id.
 */
const requestKey = (peerId: string, id: string) => `${peerId}|${id}`;

export class MessageProcessor {
  private algo: algorand;
  private model: OpenAIInferenceModel;
  private quoteMgr: quoteEngine;
  private models: ModelAvailability;
  private nodeEvents: EventEmitter;
  private messageRouter: MessageRouter;
  private env: Environment;
  private ownPeerId: string;
  private node: any;
  private speculativeCache: SpeculativeInferenceCache;
  private settlement: SettlementRegistry;
  // Quotes this node issued, until accepted or expired (see `IssuedQuote`).
  private issuedQuotes = new ExpiringMap<string, IssuedQuote>();
  // Challenges issued on quote-accepted, each holding the completion withheld
  // until the requester's x402 payment verifies (see `IssuedContract`).
  private contracts = new ExpiringMap<string, IssuedContract>();
  // Requester side: who each of our requests was handed to (see `RequestLedger`).
  private requests: RequestLedger;

  constructor(
    algo: algorand,
    model: OpenAIInferenceModel,
    quoteMgr: quoteEngine,
    models: ModelAvailability,
    nodeEvents: EventEmitter,
    messageRouter: MessageRouter,
    ownPeerId: string,
    node: any,
    requests: RequestLedger = new RequestLedger()
  ) {
    this.algo = algo;
    this.model = model;
    this.quoteMgr = quoteMgr;
    this.models = models;
    this.nodeEvents = nodeEvents;
    this.messageRouter = messageRouter;
    this.env = environment;
    this.ownPeerId = ownPeerId;
    this.node = node;
    this.requests = requests;
    this.speculativeCache = new SpeculativeInferenceCache(
      this.env.quoteEngine?.maxSpeculativeJobs ?? 2
    );
    // Settlement seam. Escrow has been retired; x402 is the only method.
    this.settlement = new SettlementRegistry();
    this.registerSettlementProviders();
  }

  /**
   * Register the settlement providers this node offers. x402 needs an Algorand
   * wallet and network, so it is skipped in local mode (payments bypassed) and
   * when no `algorand` block is configured — such a node simply won't quote.
   */
  private registerSettlementProviders(): void {
    if (this.env.local?.enabled || !this.env.algorand) return;
    const settlementCfg = this.env.algorand.settlement;
    const methods = settlementCfg?.methods ?? ['x402'];
    if (methods.includes('x402')) {
      this.settlement.register(new X402Settlement({
        account: this.algo.account,
        network: this.env.algorand.network ?? 'mainnet',
        usdcAssetId: diiiscoAssets.usdc,
        facilitatorUrl: settlementCfg?.x402?.facilitatorUrl ?? 'https://facilitator.goplausible.xyz/',
        algodUrl: this.env.algorand.client.address,
        algodToken: this.env.algorand.client.token,
        algodPort: this.env.algorand.client.port,
        selfSubmitFallback: settlementCfg?.x402?.selfSubmitFallback ?? true,
        quoteTtlSeconds: Math.round(QUOTE_TTL_MS / 1000),
      }));
      logger.info('⚙️ x402 settlement provider registered');
    }
  }

  /**
   * Settlement provider for a given quote, from the method the requester
   * negotiated into the `quote-accepted` payload (which propagates onto the
   * later contract and inference-response messages via payload spread). Falls
   * back to the first registered provider when unset. Throws if none are
   * registered — but this is unreachable, since a node with no provider never
   * quotes (see `handleQuoteRequest`).
   */
  private settlementFor(msg: { payload?: any }): SettlementProvider {
    const method = msg?.payload?.settlementMethod as SettlementMethod | undefined;
    if (method && this.settlement.has(method)) {
      return this.settlement.get(method);
    }
    return this.settlement.get(this.settlement.methods()[0]);
  }

  /**
   * Settlement methods this node offers on a quote: its configured preference
   * order intersected with the providers actually registered. May be empty
   * (a node with no settlement provider cannot sell).
   */
  private offeredSettlementMethods(): SettlementMethod[] {
    const preference = this.env.algorand?.settlement?.methods ?? this.settlement.methods();
    return preference.filter((m) => this.settlement.has(m));
  }

  /**
   * Process incoming message from any transport (GossipSub or direct)
   * @param msg The message to process
   * @param sourcePeerId The peer ID of the sender
   * @returns true if message was processed successfully
   */
  async process(msg: PubSubMessage, sourcePeerId: string): Promise<boolean> {
    // Verify the sender's address and signature. The message is a stranger's
    // bytes: a malformed address or signature makes these throw, and a throw
    // here would be an unhandled rejection, which exits the process. Treat
    // anything that cannot be verified as unverified.
    try {
      // Verify the Algorand Address from the Sender
      if (!msg.fromWalletAddr || !this.algo.isValidAddress(msg.fromWalletAddr)) {
        logger.warn("❌ Message rejected due to invalid Algorand address.");
        return false;
      }

      // Verify the Signature exists on the Message
      if (!msg.signature) {
        logger.warn("❌ Message rejected due to missing signature.");
        return false;
      }

      // Verify the Signature is Correct
      const verifiedMessage: boolean = await this.algo.verifySignature(msg);
      if (!verifiedMessage) {
        logger.warn("❌ Message rejected due to invalid signature.");
        logger.debug("Rejected Message:", msg.role);
        return false;
      }
    } catch (err: any) {
      logger.warn(`❌ Message (${String((msg as any)?.role).slice(0, 32)}) rejected: could not be verified (${err?.message ?? err}).`);
      return false;
    }
    logger.info("🔐 Signature of incoming message has been successfully verified.");

    // Learn how to reach the sender directly. The signed message carries the
    // sender's current multiaddrs (incl. relay-circuit addresses), so we can
    // populate the peerstore and later dial them without a DHT lookup.
    await this.ingestSenderAddresses(msg, sourcePeerId);

    // Route to specific handler based on message role
    try {
      switch (msg.role) {
        case 'list-models':
          await this.handleListModels(msg as ListModelsRequest, sourcePeerId);
          break;
        case 'list-models-response':
          await this.handleListModelsResponse(msg as ListModelsResponse, sourcePeerId);
          break;
        case 'list-network':
          await this.handleListNetwork(msg as ListNetworkRequest, sourcePeerId);
          break;
        case 'list-network-response':
          await this.handleListNetworkResponse(msg as ListNetworkResponse, sourcePeerId);
          break;
        case 'node-profile':
          await this.handleNodeProfile(msg as NodeProfileRequest, sourcePeerId);
          break;
        case 'node-profile-response':
          await this.handleNodeProfileResponse(msg as NodeProfileResponse, sourcePeerId);
          break;
        case 'quote-request':
          await this.handleQuoteRequest(msg as QuoteRequest, sourcePeerId);
          break;
        case 'quote-response':
          await this.handleQuoteResponse(msg as QuoteResponse, sourcePeerId);
          break;
        case 'quote-accepted':
          await this.handleQuoteAccepted(msg as QuoteAccepted, sourcePeerId);
          break;
        case 'contract-created':
          await this.handleContractCreated(msg as ContractCreated, sourcePeerId);
          break;
        case 'contract-signed':
          await this.handleContractSigned(msg as ContractSigned, sourcePeerId);
          break;
        case 'inference-response':
          await this.handleInferenceResponse(msg as InferenceResponse, sourcePeerId);
          break;
        case 'inference-failed':
          await this.handleInferenceFailed(msg as InferenceFailed, sourcePeerId);
          break;
        default:
          logger.warn(`⚠️ Unknown message role: ${(msg as any).role}`);
          return false;
      }
      return true;
    } catch (err: any) {
      logger.error(`❌ Error processing ${msg.role} message: ${err.message}`);
      return false;
    }
  }

  /**
   * Merge the sender's advertised multiaddrs into the peerstore so that
   * subsequent direct messages can dial them (over a relay circuit if needed)
   * without relying on the DHT. Only called after the signature is verified, so
   * the addresses are authenticated as belonging to the sending wallet.
   */
  private async ingestSenderAddresses(msg: PubSubMessage, sourcePeerId: string): Promise<void> {
    const addrs = msg.multiaddrs;
    if (!addrs || addrs.length === 0) return;
    // GossipSub echoes our own messages back (emitSelf) — nothing to learn.
    if (sourcePeerId === this.ownPeerId) return;

    try {
      const peerId = peerIdFromString(sourcePeerId);
      const multiaddrs = addrs.map((a) => multiaddr(a));
      await this.node.peerStore.merge(peerId, { multiaddrs });
      logger.debug(`📍 Learned ${multiaddrs.length} address(es) for ${sourcePeerId.slice(0, 16)}... from ${msg.role}`);
    } catch (err: any) {
      logger.debug(`Could not ingest addresses from ${sourcePeerId.slice(0, 16)}...: ${err.message}`);
    }
  }

  private async handleListModels(msg: ListModelsRequest, sourcePeerId: string) {
    if (!this.env.models.enabled) {
      return;
    }

    // The monitor's snapshot, not a fresh backend call: a `list-models` is a
    // network-wide broadcast, and a node with a stopped backend must answer
    // with nothing rather than throw.
    const models_list = this.models.models();
    const response: ListModelsResponse = {
      role: 'list-models-response',
      timestamp: Date.now(),
      id: msg.id,
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: {
        models: models_list,
      }
    };
    response.signature = await this.algo.signObject(response);

    // Send via router (will use GossipSub for discovery messages)
    await this.messageRouter.sendMessage(response);
    logger.info(`📤 Sent list-models-response to ${sourcePeerId}`);
  }

  private async handleListModelsResponse(msg: ListModelsResponse, sourcePeerId: string) {
    // Note: msg.to check removed because we need the peer ID from the node, not from this class
    // This will be handled by checking if the message is addressed to us in the main handler
    this.model.addModel(msg.payload.models);
  }

  private async handleListNetwork(msg: ListNetworkRequest, sourcePeerId: string) {
    const response: ListNetworkResponse = {
      role: 'list-network-response',
      timestamp: Date.now(),
      id: msg.id,
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: {
        node: {
          peerId: this.ownPeerId,
          walletAddr: this.algo.account.addr.toString(),
          nfd: this.algo.nfdVerified ? (this.algo.nfdAddr ?? undefined) : undefined,
          displayName: this.env.node?.displayName,
        }
      }
    };
    response.signature = await this.algo.signObject(response);
    await this.messageRouter.sendMessage(response);
    logger.info(`📤 Sent list-network-response to ${sourcePeerId}`);
  }

  private async handleListNetworkResponse(msg: ListNetworkResponse, _sourcePeerId: string) {
    const node = msg.payload.node;
    let verifiedNfd: string | undefined = undefined;
    if (node.nfd) {
      const isValid = await verifyNFD(node.peerId, node.walletAddr, node.nfd).catch(() => false);
      if (isValid) verifiedNfd = node.nfd;
    }
    this.nodeEvents.emit('network-node-received', { ...node, nfd: verifiedNfd });
  }

  private async handleNodeProfile(msg: NodeProfileRequest, sourcePeerId: string) {
    // A node that disabled its status pages also doesn't answer profile queries.
    if (this.env.node?.statusPages === false) {
      return;
    }

    const response: NodeProfileResponse = {
      role: 'node-profile-response',
      timestamp: Date.now(),
      id: msg.id,
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: {
        profile: buildOwnProfile(this.node, this.algo, this.models.list(), (id) => this.models.kindOf(id)),
      }
    };
    response.signature = await this.algo.signObject(response);
    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent node-profile-response to ${sourcePeerId}`);
  }

  private async handleNodeProfileResponse(msg: NodeProfileResponse, sourcePeerId: string) {
    const profile = msg.payload?.profile;
    if (!profile || typeof profile.peerId !== 'string') {
      return;
    }

    // A profile is self-reported — only accept it from the peer it claims to
    // describe, so a node can't impersonate another's profile.
    if (profile.peerId !== sourcePeerId) {
      logger.warn(`❌ Dropping node-profile-response: profile claims ${profile.peerId.slice(0, 16)}... but came from ${sourcePeerId.slice(0, 16)}...`);
      return;
    }

    let nfdVerified = false;
    if (profile.nfd && profile.walletAddr) {
      nfdVerified = await verifyNFD(profile.peerId, profile.walletAddr, profile.nfd).catch(() => false);
    }

    this.nodeEvents.emit(`node-profile-received-${msg.id}`, {
      ...profile,
      nfd: nfdVerified ? profile.nfd : undefined,
      nfdVerified: nfdVerified || undefined,
    });
  }

  private async handleQuoteRequest(msg: QuoteRequest, sourcePeerId: string) {
    // Verified against the backend rather than a startup snapshot, and checked
    // first: an unserveable model must cost a localhost probe, not an on-chain
    // lookup. A node whose backend has stopped drops out of the auction here.
    if (!(await this.models.ensureAvailable(msg.payload.model))) {
      logger.debug(`🚫 Not quoting ${msg.payload.model} — not currently served by this node.`);
      return;
    }

    // The request's kind has to match the model's. An embedding model cannot
    // answer a chat request, and a decision model "answers" one with an empty
    // message, so quoting for either would win the auction and then fail it.
    // The reverse holds for System One: only a decision model can answer it.
    const wanted = this.requiredKind(msg.payload);
    if (this.models.kindOf(msg.payload.model) !== wanted) {
      logger.debug(`🚫 Not quoting ${msg.payload.model} — it is a ${this.models.kindOf(msg.payload.model)} model, and this request needs a ${wanted} model.`);
      return;
    }

    // On the public network a node must have a settlement method to sell.
    // (Local mode bypasses settlement entirely.)
    if (!this.env.local?.enabled) {
      if (this.offeredSettlementMethods().length === 0) {
        logger.warn(`❌ Quote request from ${msg.fromWalletAddr} cannot be fulfilled - no settlement provider registered.`);
        return;
      }
      const x = await this.algo.checkIfOptedInToAsset(msg.fromWalletAddr, diiiscoAssets.asset);
      if (!x.optedIn) {
        logger.warn(`❌ Quote request from ${msg.fromWalletAddr} cannot be fulfilled - not opted in or zero balance.`);
        return;
      }
    }

    // Generate Quote
    const rawQuote: RawQuote | null = await this.quoteMgr.createQuote(msg, this.model);
    if (rawQuote === null) {
      logger.warn(`❌ Quote request from ${msg.fromWalletAddr} cannot be fulfilled - no quote creation function returned a quote.`);
      return;
    }

    // Remember what was promised: the accept is checked against this, not
    // against whatever the requester echoes back.
    this.issuedQuotes.set(requestKey(sourcePeerId, msg.id), {
      model: msg.payload.model,
      kind: msg.payload.kind,
      rates: { input: rawQuote.pricePerInputToken1M, output: rawQuote.pricePerOutputToken1M },
      maxSpend: msg.payload.maxSpend,
    }, QUOTE_TTL_MS);

    // Create Quote Response
    let response: QuoteResponse = {
      role: 'quote-response',
      timestamp: Date.now(),
      id: msg.id,
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: {
        ...msg.payload,
        quote: {
          model: msg.payload.model,
          tokenCount: rawQuote.inputTokens,
          addr: this.algo.account.addr.toString(),
          // Per-token rates: the provider's signed price commitment (§4.2).
          pricePerInputToken1M: rawQuote.pricePerInputToken1M,
          pricePerOutputToken1M: rawQuote.pricePerOutputToken1M,
          // Settlement negotiation: the requester picks one of these methods.
          settlementMethods: this.offeredSettlementMethods(),
          assetId: diiiscoAssets.usdc,
          quoteExpiresAt: Date.now() + QUOTE_TTL_MS,
          // Echoed so the requester can measure how quickly we responded.
          requestTimestamp: msg.timestamp,
          // Advertised NFD name + our peer id so the requester can verify the NFD.
          nfd: this.env.algorand?.nfd,
          providerPeerId: this.ownPeerId,
        },
      }
    };

    response.signature = await this.algo.signObject(response);

    // Send via router (will use GossipSub for discovery messages)
    await this.messageRouter.sendMessage(response);
    logger.info(`📤 Sent quote-response to ${sourcePeerId}`);
  }

  private async handleQuoteResponse(msg: QuoteResponse, sourcePeerId: string) {
    // Request ids travel in the clear on the broadcast quote-request, so any
    // peer can address a quote to us for any of them. Only an auction this node
    // has open and is still collecting quotes for may receive one: it keeps a
    // stranger's quote out of the running, and stops late quotes for a finished
    // request from starting a selection nobody is waiting for.
    if (!this.requests.isCollectingQuotes(msg.id)) {
      logger.debug(`🚫 Dropped a quote-response for ${msg.id} from ${sourcePeerId.slice(0, 16)}... — no open auction.`);
      return;
    }
    logger.info(`📥 Received quote-response from ${sourcePeerId}`);
    this.quoteMgr.addQuote({ msg: msg, from: sourcePeerId });
  }

  /**
   * Provider side. Optimistic-inference-then-pay-to-unlock (x402):
   * run inference now, withhold the result, and challenge the requester to pay
   * the actual metered charge before the answer is released.
   */
  private async handleQuoteAccepted(msg: QuoteAccepted, sourcePeerId: string) {
    try {
      await this.serveAcceptedQuote(msg, sourcePeerId);
    } catch (err) {
      // Going quiet here is what used to hang the requester for its whole
      // deadline. Tell it instead, so it can re-auction to somebody else.
      logger.error(`❌ Could not serve accepted quote ${msg.id}: ${(err as Error).message}`);
      // `runInference` invalidated the availability snapshot on the way out, so
      // this re-probes: it distinguishes "the backend is gone" from a one-off
      // error, and leaves the node correctly filtered for the next quote too.
      const stillServing = await this.models.ensureAvailable(msg.payload?.model);
      await this.sendInferenceFailed(msg, sourcePeerId, stillServing ? 'error' : 'backend-unavailable');
    }
  }

  /** The kind of model a request can be served by. */
  private requiredKind(payload: { kind?: string }): ModelKind {
    return payload?.kind === 'systemone' ? 'decision' : 'chat';
  }

  /**
   * Re-check, at accept time, what the quote stage already checked: the payload
   * is the requester's word, and the prompt content only arrives now. A request
   * for a kind this model is not never reaches the backend.
   */
  private assertServable(payload: any): void {
    const wanted = this.requiredKind(payload);
    if (this.models.kindOf(payload?.model) !== wanted) {
      throw new Error(`"${payload?.model}" is not a ${wanted} model`);
    }
    if (payload?.kind === 'systemone') {
      const problem = validateSystemOneRequest(payload);
      if (problem) throw new Error(`invalid System One request: ${problem}`);
    }
  }

  private async serveAcceptedQuote(msg: QuoteAccepted, sourcePeerId: string) {
    // Local mode / self-served quotes settle nothing — answer immediately.
    const direct = this.env.local?.enabled || sourcePeerId === this.ownPeerId;

    // Otherwise the accept must be for a quote *this* node issued to *this*
    // peer, and is spent by it: a replay, a stranger, or a made-up id finds
    // nothing and costs no inference.
    const issued = direct ? undefined : this.issuedQuotes.take(requestKey(sourcePeerId, msg.id));
    if (!direct && !issued) {
      logger.warn(`❌ Ignoring quote-accepted ${msg.id} from ${sourcePeerId.slice(0, 16)}... — no matching quote was issued to that peer.`);
      return;
    }
    if (issued && (msg.payload?.model !== issued.model || this.requiredKind(msg.payload) !== this.requiredKind(issued))) {
      logger.warn(`❌ Ignoring quote-accepted ${msg.id} — it asks for a different model or request kind than was quoted.`);
      return;
    }

    this.assertServable(msg.payload);

    if (direct) {
      const completion = await this.runInference(msg);
      await this.sendInferenceResponse(msg, sourcePeerId, completion);
      return;
    }

    // Cap generation at what the requester's budget affords (§4.2 C), so the
    // provider never spends more compute than the budget pays for. Priced at
    // the rates it was quoted, against the budget it was quoted for.
    const outputCap = await this.budgetOutputCap(msg, issued!);
    if (outputCap === undefined) {
      logger.warn(`❌ Cannot serve ${msg.id} within the requester's budget.`);
      await this.sendInferenceFailed(msg, sourcePeerId, 'budget-exceeded');
      return;
    }

    // Optimistic inference: start as soon as the quote is accepted (budget-capped).
    if (this.env.quoteEngine?.optimisticInference !== false) {
      this.speculativeCache.start(msg.id, () => this.invoke(msg.payload, outputCap));
    }

    // Compute the answer, hold it, and bill the actual usage (clamped to maxSpend).
    const completion = await this.runInference(msg, outputCap);

    const charge = this.chargeForCompletion(msg.payload, completion, issued!);
    const amount = BigInt(Math.round(charge * 1_000_000));
    const paymentRequirements = await this.settlementFor(msg).createPaymentRequest({ quoteId: msg.id, amount });

    // What we issued, kept: the payment is verified against this, and the answer
    // is released only to the peer it was computed for.
    this.contracts.set(requestKey(sourcePeerId, msg.id), { requirements: paymentRequirements, completion }, COMPLETION_TTL_MS);

    let response: ContractCreated = {
      ...msg,
      role: "contract-created",
      timestamp: Date.now(),
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: { ...msg.payload, paymentRequirements },
    };
    response.signature = await this.algo.signObject(response);

    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent contract-created (payment challenge) to ${sourcePeerId}`);
  }

  /**
   * Requester side. The answer is ready; pay to unlock it. The spending gate
   * here is the security anchor (§4.2 E): this node signs a payment only for a
   * request it made, only when asked by the peer it handed that request to, only
   * once, only to that provider's wallet, only in USDC on its own network, and
   * never above its **local** `maxSpend` (refusing outright if none is set) —
   * so it can never sign an unbounded cheque, or any cheque at all for a
   * stranger, no matter what a modified provider or bystander requests.
   */
  private async handleContractCreated(msg: ContractCreated, sourcePeerId: string) {
    const request = msg.payload?.paymentRequirements;
    if (!request) {
      logger.warn(`❌ contract-created for ${msg.id} carried no payment requirements.`);
      return;
    }

    // Is this a request we made, and is the sender who we sent it to? The peer
    // id is the identity: the transport authenticates it, and — unlike a wallet
    // address — it is not shared between nodes.
    const provider = this.requests.providerFor(msg.id);
    if (!provider) {
      logger.warn(`❌ Refusing to pay ${msg.id}: it is not an outstanding request of this node.`);
      return;
    }
    if (sourcePeerId !== provider.peerId) {
      logger.warn(`❌ Refusing to pay ${msg.id}: the request came from ${sourcePeerId.slice(0, 16)}..., not the selected provider.`);
      return;
    }

    const localMaxSpend = this.env.algorand?.settlement?.maxSpend;
    if (localMaxSpend === undefined || localMaxSpend <= 0) {
      logger.warn(`❌ Refusing to pay ${msg.id}: no local maxSpend configured (never sign an unbounded cheque).`);
      return;
    }

    // The right asset, on the right network, to the provider that quoted.
    const settlement = this.settlementFor(msg);
    const problem = settlement.checkRequest(request, provider.payTo);
    if (problem) {
      logger.warn(`❌ Refusing to pay ${msg.id}: ${problem}.`);
      return;
    }
    const requestedAmount = BigInt(request.amount);
    if (requestedAmount > BigInt(Math.round(localMaxSpend * 1_000_000))) {
      logger.warn(`❌ Payment request for ${msg.id} (${requestedAmount} µUSDC) exceeds local maxSpend; refusing.`);
      return;
    }

    // One payment per request. Claimed before the (async) signing, so a repeated
    // contract-created cannot sign twice.
    if (!this.requests.claimPayment(msg.id)) {
      logger.warn(`❌ Refusing to pay ${msg.id} again: it has already been paid.`);
      return;
    }

    let paymentPayload;
    try {
      paymentPayload = await settlement.pay({ quoteId: msg.id, amount: requestedAmount, request });
    } catch (err) {
      this.requests.unclaimPayment(msg.id);
      throw err;
    }

    let response: ContractSigned = {
      ...msg,
      role: "contract-signed",
      timestamp: Date.now(),
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: { ...msg.payload, paymentPayload },
    };
    response.signature = await this.algo.signObject(response);

    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent contract-signed (proof-of-payment) to ${sourcePeerId}`);
  }

  /**
   * Provider side. Verify the payment off-chain (facilitator verify); on success
   * release the withheld answer and settle on-chain in the background.
   *
   * Everything is checked against what this node issued, never against the
   * requester's message: the challenge is looked up by the sending peer and the
   * request id, it is consumed on first use, and the payment must satisfy the
   * requirements held in it.
   */
  private async handleContractSigned(msg: ContractSigned, sourcePeerId: string) {
    const contract = this.contracts.take(requestKey(sourcePeerId, msg.id));
    if (!contract) {
      logger.warn(`❌ Ignoring contract-signed ${msg.id} from ${sourcePeerId.slice(0, 16)}... — no pending payment challenge for that peer (unknown, expired or already used).`);
      return;
    }

    const evidence = msg.payload?.paymentPayload;
    const settlement = this.settlementFor(msg);

    const verified = await settlement.verifyPayment({
      quoteId: msg.id,
      expected: contract.requirements,
      evidence,
    });
    if (!verified.ok) {
      logger.warn(`❌ Payment for ${msg.id} did not verify (${verified.reason ?? 'unknown'}). Withholding result.`);
      return;
    }

    await this.sendInferenceResponse(msg, sourcePeerId, contract.completion);

    // Settlement (the on-chain txn) is off the critical path — the requester
    // already has the answer. Retry with backoff on facilitator hiccups.
    this.settleInBackground(settlement, msg.id, contract.requirements, evidence);
  }

  /** Resolve a (possibly speculative) inference result, capping output if given. */
  private async runInference(msg: { id: string; payload: any }, outputCap?: number): Promise<any> {
    const cached = await this.speculativeCache.resolve(msg.id);
    if (cached) return cached;

    try {
      return await this.invoke(msg.payload, outputCap);
    } catch (err) {
      // The backend just failed us mid-request. Re-probe before the next quote
      // rather than waiting out the poll interval, so this node stops quoting
      // for a model it cannot serve on the very next request.
      this.models.invalidate();
      throw err;
    }
  }

  /** Run the request on the backend: a System One question set, or a chat completion. */
  private invoke(payload: any, outputCap?: number): Promise<any> {
    if (payload?.kind === 'systemone') {
      return this.model.systemOne({ model: payload.model, state: payload.state, questions: payload.questions });
    }
    return this.model.getResponse(payload.model, payload.inputs, this.genParams(payload, outputCap));
  }

  /** Generation params for the runtime, with the budget-derived output cap applied. */
  private genParams(payload: any, outputCap?: number) {
    const params = pickGenerationParams(payload);
    // Number.MAX_SAFE_INTEGER is the free-output sentinel (§4.2) — leave uncapped.
    if (outputCap !== undefined && outputCap !== Number.MAX_SAFE_INTEGER) {
      params.max_tokens = outputCap;
    }
    return params;
  }

  /**
   * Output-token cap the requester's budget affords (§4.2 C), or `undefined` if
   * the request can't be served within it. Now that the prompt content arrives
   * with quote-accepted, the provider re-counts the input from the real content
   * — this is the real budget enforcement (the quote-time count was advisory).
   * Rates and budget are the ones recorded when the quote was issued.
   */
  private async budgetOutputCap(msg: { payload: any }, issued: IssuedQuote): Promise<number | undefined> {
    const plan = planBudget(this.countInput(msg.payload), issued.rates, issued.maxSpend, msg.payload.max_tokens);
    return plan.canServe ? plan.outputCap : undefined;
  }

  /**
   * Input tokens of a request, counted from its real content the same way the
   * requester counted them (tools included), or the two sides disagree about
   * what the budget affords.
   */
  private countInput(payload: any): number {
    return payload.kind === 'systemone'
      ? countSystemOneInputTokens(payload.state, payload.questions)
      : countInputTokens(payload.inputs, payload.tools);
  }

  private async sendInferenceResponse(msg: { id: string; payload: any }, sourcePeerId: string, completion: any) {
    nodeStats.inferencesServed++;
    let response: InferenceResponse = {
      role: 'inference-response',
      to: sourcePeerId,
      timestamp: Date.now(),
      id: msg.id,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: { ...msg.payload, completion },
    };
    response.signature = await this.algo.signObject(response);
    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent inference-response to ${sourcePeerId}`);
  }

  /**
   * Actual charge = metered from real usage (§4.2 D), at the rates this node
   * quoted, clamped to the budget it was quoted for and floored at the 1 µUSDC
   * minimum transfer. Nothing here is read from the requester's message.
   */
  private chargeForCompletion(payload: any, completion: any, issued: IssuedQuote): number {
    return Math.max(priceFromUsage(this.meterUsage(payload, completion), issued.rates, issued.maxSpend ?? 0), MIN_CHARGE);
  }

  /**
   * Token usage of a finished request. A backend that reports none (some
   * runtimes omit `usage`) must not make the answer free, so what it leaves out
   * is counted here, from the request and the completion.
   */
  private meterUsage(payload: any, completion: any): { prompt_tokens: number; completion_tokens: number } {
    const reported = normalizeUsage(completion?.usage);
    const systemOne = payload?.kind === 'systemone';
    const output = systemOne
      ? countInputTokens([JSON.stringify(completion?.answers ?? {})])
      : countInputTokens((completion?.choices ?? []).map((c: any) => c?.message).filter(Boolean));
    return {
      prompt_tokens: reported.prompt_tokens ?? this.countInput(payload),
      completion_tokens: reported.completion_tokens ?? output,
    };
  }

  /**
   * Provider side. Tell the requester this quote cannot be served, so it can
   * re-auction immediately rather than waiting out its deadline. Carries no
   * completion and no prompt — only the model and a coarse reason.
   */
  private async sendInferenceFailed(msg: { id: string; payload: any }, sourcePeerId: string, reason: InferenceFailureReason) {
    let response: InferenceFailed = {
      role: 'inference-failed',
      to: sourcePeerId,
      timestamp: Date.now(),
      id: msg.id,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: { model: msg.payload?.model, reason },
    };
    try {
      response.signature = await this.algo.signObject(response);
      await this.messageRouter.sendMessage(response, sourcePeerId);
      logger.info(`📤 Sent inference-failed (${reason}) to ${sourcePeerId}`);
    } catch (err) {
      // Best-effort: the requester's deadline is the backstop.
      logger.warn(`⚠️ Could not send inference-failed for ${msg.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Requester side. A provider bowed out. The API layer decides whether to
   * re-auction; it also checks that this came from the provider it actually
   * selected, so a bystander cannot cancel someone else's request.
   */
  private async handleInferenceFailed(msg: InferenceFailed, sourcePeerId: string) {
    logger.warn(`📥 Received inference-failed from ${sourcePeerId} for ${msg.id} (${msg.payload?.reason})`);
    this.nodeEvents.emit(`inference-failed-${msg.id}`, {
      from: sourcePeerId,
      fromWalletAddr: msg.fromWalletAddr,
      model: msg.payload?.model,
      reason: msg.payload?.reason ?? 'error',
    });
  }

  /** Requester side. The answer arrived; surface it to the API. */
  private async handleInferenceResponse(msg: InferenceResponse, sourcePeerId: string) {
    logger.info(`📥 Received inference-response from ${sourcePeerId}`);
    this.nodeEvents.emit(`inference-response-${msg.id}`, {
      ...msg,
      // The transport-authenticated sender, for the requester to check against
      // the provider it chose (the message body is the sender's own claim).
      from: sourcePeerId,
      payment: null,
      quote: msg.payload.quote,
    });
  }

  private settleInBackground(settlement: SettlementProvider, quoteId: string, expected: PaymentRequest, evidence: any): void {
    const DELAYS_MS = [1000, 2000, 4000, 8000];

    const attempt = (i: number): void => {
      settlement.settle({ quoteId, expected, evidence }).then((result) => {
        logger.info(`✅ Quote ${quoteId} settled (attempt ${i + 1})${result.txid ? ` — txid ${result.txid}` : ''}`);
      }).catch((err: Error) => {
        if (i < DELAYS_MS.length - 1) {
          logger.warn(`⚠️ Settlement attempt ${i + 1} failed for ${quoteId}, retrying in ${DELAYS_MS[i]}ms: ${err.message}`);
          setTimeout(() => attempt(i + 1), DELAYS_MS[i]);
        } else {
          logger.error(`💀 Settlement permanently failed for quote ${quoteId}: ${err.message}`, { quoteId });
        }
      });
    };

    attempt(0);
  }
}
