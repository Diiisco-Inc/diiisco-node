import { EventEmitter } from 'events';
import algorand from "../utils/algorand";
import environment from "../environment/environment";
import { OpenAIInferenceModel } from "../utils/models";
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
  ListModelsResponse
} from "../types/messages";
import { logger } from '../utils/logger';
import { Environment } from "../environment/environment.types";
import diiiscoContract from "../utils/contract";
import { RawQuote } from "../types/quotes";
import { Address } from "algosdk";
import { MessageRouter } from './messageRouter';

export class MessageProcessor {
  private algo: algorand;
  private model: OpenAIInferenceModel;
  private quoteMgr: quoteEngine;
  private availableModels: string[];
  private nodeEvents: EventEmitter;
  private messageRouter: MessageRouter;
  private env: Environment;

  constructor(
    algo: algorand,
    model: OpenAIInferenceModel,
    quoteMgr: quoteEngine,
    availableModels: string[],
    nodeEvents: EventEmitter,
    messageRouter: MessageRouter
  ) {
    this.algo = algo;
    this.model = model;
    this.quoteMgr = quoteMgr;
    this.availableModels = availableModels;
    this.nodeEvents = nodeEvents;
    this.messageRouter = messageRouter;
    this.env = environment;
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

    // Route to specific handler based on message role
    try {
      switch (msg.role) {
        case 'list-models':
          await this.handleListModels(msg as ListModelsRequest, sourcePeerId);
          break;
        case 'list-models-response':
          await this.handleListModelsResponse(msg as ListModelsResponse, sourcePeerId);
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

  private async handleQuoteRequest(msg: QuoteRequest, sourcePeerId: string) {
    if (!this.availableModels.includes(msg.payload.model)) {
      return;
    }

    // Check If Opted In to DSCO
    const x = await this.algo.checkIfOptedInToAsset(msg.fromWalletAddr, diiiscoContract.asset);
    if (!x.optedIn) {
      logger.warn(`❌ Quote request from ${msg.fromWalletAddr} cannot be fulfilled - not opted in or zero balance.`);
      return;
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
    await this.algo.createQuote({
      quoteId: msg.id,
      customerAddress: msg.fromWalletAddr,
      usdcAmount: BigInt(msg.payload.quote.totalPrice * 1_000_000),
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
    await this.algo.fundQuote({
      quoteId: msg.id,
      usdcAmount: BigInt(msg.payload.quote.totalPrice * 1_000_000),
    });

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

    // Execute Inference
    const completion = await this.model.getResponse(msg.payload.model, msg.payload.inputs);
    let response: InferenceResponse = {
      role: 'inference-response',
      to: sourcePeerId,
      timestamp: Date.now(),
      id: msg.id,
      fromWalletAddr: this.env.algorand.addr,
      payload: {
        ...msg.payload,
        completion: completion,
      }
    };

    response.signature = await this.algo.signObject(response);

    // Send via router (will use direct messaging for post-selection)
    await this.messageRouter.sendMessage(response, sourcePeerId);
    logger.info(`📤 Sent inference-response to ${sourcePeerId}`);
  }

  private async handleInferenceResponse(msg: InferenceResponse, sourcePeerId: string) {
    logger.info(`📥 Received inference-response from ${sourcePeerId}`);
    const payment = await this.algo.completeQuote({
      quoteId: msg.id,
      provider: Address.fromString(msg.fromWalletAddr)
    });
    this.nodeEvents.emit(`inference-response-${msg.id}`, {
      ...msg,
      payment: payment,
      quote: msg.payload.quote
    });
  }
}
