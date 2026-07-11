import { EventEmitter } from 'events';
import algorand from "../utils/algorand";
import environment from "../environment/environment";
import { OpenAIInferenceModel, pickGenerationParams } from "../utils/models";
import quoteEngine from "../utils/quoteEngine";
import {
  PubSubMessage,
  QuoteRequest,
  QuoteResponse,
  QuoteAccepted,
  InferenceResponse,
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
import diiiscoContract from "../utils/contract";
import { verifyNFD } from '../utils/algorand';
import { RawQuote } from "../types/quotes";
import { Address } from "algosdk";
import { MessageRouter } from './messageRouter';
import { SpeculativeInferenceCache } from './speculativeInferenceCache';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';

export class MessageProcessor {
  private algo: algorand;
  private model: OpenAIInferenceModel;
  private quoteMgr: quoteEngine;
  private availableModels: string[];
  private nodeEvents: EventEmitter;
  private messageRouter: MessageRouter;
  private env: Environment;
  private ownPeerId: string;
  private node: any;
  private speculativeCache: SpeculativeInferenceCache;

  constructor(
    algo: algorand,
    model: OpenAIInferenceModel,
    quoteMgr: quoteEngine,
    availableModels: string[],
    nodeEvents: EventEmitter,
    messageRouter: MessageRouter,
    ownPeerId: string,
    node: any
  ) {
    this.algo = algo;
    this.model = model;
    this.quoteMgr = quoteMgr;
    this.availableModels = availableModels;
    this.nodeEvents = nodeEvents;
    this.messageRouter = messageRouter;
    this.env = environment;
    this.ownPeerId = ownPeerId;
    this.node = node;
    this.speculativeCache = new SpeculativeInferenceCache(
      this.env.quoteEngine?.maxSpeculativeJobs ?? 2
    );
  }

  /**
   * Process incoming message from any transport (GossipSub or direct)
   * @param msg The message to process
   * @param sourcePeerId The peer ID of the sender
   * @returns true if message was processed successfully
   */
  async process(msg: PubSubMessage, sourcePeerId: string): Promise<boolean> {
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

    const models_list = await this.model.getModels();
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
        profile: buildOwnProfile(this.node, this.algo, this.availableModels),
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
    if (!this.availableModels.includes(msg.payload.model)) {
      return;
    }

    // Check If Opted In to DSCO (skipped in local mode)
    if (!this.env.local?.enabled) {
      const x = await this.algo.checkIfOptedInToAsset(msg.fromWalletAddr, diiiscoContract.asset);
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
          inputCount: msg.payload.inputs.length,
          tokenCount: rawQuote.tokens,
          pricePer1M: rawQuote.rate,
          totalPrice: rawQuote.price,
          addr: this.algo.account.addr.toString(),
        },
      }
    };

    response.signature = await this.algo.signObject(response);

    // Send via router (will use GossipSub for discovery messages)
    await this.messageRouter.sendMessage(response);
    logger.info(`📤 Sent quote-response to ${sourcePeerId}`);
  }

  private async handleQuoteResponse(msg: QuoteResponse, sourcePeerId: string) {
    logger.info(`📥 Received quote-response from ${sourcePeerId}`);
    this.quoteMgr.addQuote({ msg: msg, from: sourcePeerId });
  }

  private async handleQuoteAccepted(msg: QuoteAccepted, sourcePeerId: string) {
    if (this.env.local?.enabled || sourcePeerId === this.ownPeerId) {
      await this.executeInference(msg, sourcePeerId);
      return;
    }

    const optimistic = this.env.quoteEngine?.optimisticInference !== false;
    if (optimistic) {
      this.speculativeCache.start(msg.id, () =>
        this.model.getResponse(msg.payload.model, msg.payload.inputs, pickGenerationParams(msg.payload))
      );
    }

    const createUsdcAmount = BigInt(Math.round(msg.payload.quote.totalPrice * 1_000_000));
    await this.algo.createQuote({
      quoteId: msg.id,
      customerAddress: msg.fromWalletAddr,
      usdcAmount: createUsdcAmount,
    });

    let response: ContractCreated = {
      ...msg,
      role: "contract-created",
      timestamp: Date.now(),
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
    };
    response.signature = await this.algo.signObject(response);

    // Send via router (will use direct messaging for post-selection)
    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent contract-created to ${sourcePeerId}`);
  }

  private async handleContractCreated(msg: ContractCreated, sourcePeerId: string) {
    if (!this.env.local?.enabled) {
      const fundUsdcAmount = BigInt(Math.round(msg.payload.quote.totalPrice * 1_000_000));
      await this.algo.fundQuote({
        quoteId: msg.id,
        usdcAmount: fundUsdcAmount,
      });
    }

    let response: ContractSigned = {
      ...msg,
      role: "contract-signed",
      timestamp: Date.now(),
      to: sourcePeerId,
      fromWalletAddr: this.algo.account.addr.toString(),
    };
    response.signature = await this.algo.signObject(response);

    // Send via router (will use direct messaging for post-selection)
    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent contract-signed to ${sourcePeerId}`);
  }

  private async handleContractSigned(msg: ContractSigned, sourcePeerId: string) {
    const funded = await this.algo.verifyQuoteFunded(msg.id);
    if (!funded.funded || funded.usdcAmount < BigInt(msg.payload.quote.totalPrice * 1_000_000)) {
      logger.warn(`❌ Contract ${msg.id} is not funded. Cannot proceed with inference.`);
      return;
    }

    await this.executeInference(msg, sourcePeerId);
  }

  private async executeInference(msg: { id: string; payload: any }, sourcePeerId: string) {
    const completion = await this.speculativeCache.resolve(msg.id)
      ?? await this.model.getResponse(msg.payload.model, msg.payload.inputs, pickGenerationParams(msg.payload));
    nodeStats.inferencesServed++;
    let response: InferenceResponse = {
      role: 'inference-response',
      to: sourcePeerId,
      timestamp: Date.now(),
      id: msg.id,
      fromWalletAddr: this.algo.account.addr.toString(),
      payload: {
        ...msg.payload,
        completion: completion,
      }
    };

    response.signature = await this.algo.signObject(response);
    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent inference-response to ${sourcePeerId}`);
  }

  private async handleInferenceResponse(msg: InferenceResponse, sourcePeerId: string) {
    logger.info(`📥 Received inference-response from ${sourcePeerId}`);

    // Emit immediately so the API can respond to the client without waiting for on-chain settlement.
    this.nodeEvents.emit(`inference-response-${msg.id}`, {
      ...msg,
      payment: null,
      quote: msg.payload.quote,
    });

    if (!this.env.local?.enabled && sourcePeerId !== this.ownPeerId) {
      this.settleQuoteInBackground(msg);
    }
  }

  private settleQuoteInBackground(msg: InferenceResponse): void {
    const DELAYS_MS = [1000, 2000, 4000, 8000];

    const attempt = (i: number): void => {
      this.algo.completeQuote({
        quoteId: msg.id,
        provider: Address.fromString(msg.fromWalletAddr),
      }).then(() => {
        logger.info(`✅ Quote ${msg.id} settled (attempt ${i + 1})`);
      }).catch((err: Error) => {
        if (i < DELAYS_MS.length - 1) {
          logger.warn(`⚠️ Settlement attempt ${i + 1} failed for ${msg.id}, retrying in ${DELAYS_MS[i]}ms: ${err.message}`);
          setTimeout(() => attempt(i + 1), DELAYS_MS[i]);
        } else {
          logger.error(`💀 Settlement permanently failed for quote ${msg.id}: ${err.message}`, { quoteId: msg.id, provider: msg.fromWalletAddr });
        }
      });
    };

    attempt(0);
  }
}
