import { decode, encode } from "msgpackr";
import { EventEmitter } from 'events';
import algorand from "../utils/algorand";
import environment from "../environment/environment";
import { OpenAIInferenceModel } from "../utils/models";
import quoteEngine from "../utils/quoteEngine";
import { PubSubMessage, QuoteRequest, QuoteResponse, QuoteAccepted, InferenceResponse, ContractSigned, ContractCreated } from "../types/messages";
import { logger } from '../utils/logger';
import { Environment } from "../environment/environment.types";
import diiiscoContract from "../utils/contract";

export const handlePubSubMessage = async (
  evt: any,
  node: any,
  nodeEvents: EventEmitter,
  algo: algorand,
  model: OpenAIInferenceModel,
  quoteMgr: quoteEngine,
  topics: string[],
  models: string[],
) => {
  if (topics.includes(evt.detail.topic)) {
    const msg: PubSubMessage = decode(evt.detail.data);
    const env: Environment = environment; // Use the typed environment

    //Verify the Signature on the Exists on the Message
    if (!msg.signature){
      logger.warn("❌ Message rejected due to missing signature.");
      return;
    }

    // Verify the Signature is Correct
    const verifiedMessage: boolean = await algo.verifySignature(msg);
    if (!verifiedMessage) {
      logger.warn("❌ Message rejected due to invalid signature.");
      console.log("Rejected Message:", msg.role);
      return;
    }
    logger.info("🔐 Signature of incoming message has been successfully verified.");

    const quoteRequestMsg = msg as QuoteRequest;
    if (msg.role === 'quote-request' && models.includes(quoteRequestMsg.payload.model)) {
      //Check If Opted In to DSCO
      const x = await algo.checkIfOptedInToAsset(quoteRequestMsg.fromWalletAddr, diiiscoContract.asset);
      if (!x.optedIn || Number(x.balance) <= 0) {
        logger.warn(`❌ Quote request from ${quoteRequestMsg.fromWalletAddr} cannot be fulfilled - not opted in or zero balance.`);
        return;
      }

      // Generate Quote
      const tokenCount: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
      const modelRate = env.models.chargePer1KTokens[quoteRequestMsg.payload.model] || env.models.chargePer1KTokens.default || 0.000001;
      let response: QuoteResponse = {
        role: 'quote-response',
        timestamp: Date.now(),
        id: quoteRequestMsg.id,
        to: evt.detail.from.toString(),
        fromWalletAddr: algo.account.addr.toString(),
        payload: {
          ...quoteRequestMsg.payload,
          quote: {
            model: quoteRequestMsg.payload.model,
            inputCount: quoteRequestMsg.payload.inputs.length,
            tokenCount: tokenCount,
            pricePer1K: modelRate,
            totalPrice: (tokenCount / 1000) * modelRate,
            addr: algo.account.addr.toString(),
          },
        }
      };

      response.signature = await algo.signObject(response);
      node.services.pubsub.publish('diiisco/models/1.0.0', encode(response));
      logger.info(`📤 Sent quote-response to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
    }

    if (msg.role === 'quote-response' && msg.to === node.peerId.toString()) {
      const quoteResponseMsg = msg as QuoteResponse;
      logger.info(`📥 Received quote-response: ${JSON.stringify(quoteResponseMsg)}`);
      quoteMgr.addQuote({ msg: quoteResponseMsg, from: evt.detail.from.toString() });
    }

    if (msg.role === 'quote-accepted' && msg.to === node.peerId.toString()) {
      const quoteAcceptedMsg = msg as QuoteAccepted;
      await algo.createQuote({
        quoteId: quoteAcceptedMsg.id,
        customerAddress: quoteAcceptedMsg.fromWalletAddr,
        usdcAmount: BigInt(quoteAcceptedMsg.payload.quote.totalPrice * 1_000_000), // 
      });

      let response: ContractCreated = {
        ...quoteAcceptedMsg,
        role: "contract-created",
      };
      quoteAcceptedMsg.signature = await algo.signObject(quoteAcceptedMsg);
      node.services.pubsub.publish('diiisco/models/1.0.0', encode(response));
      logger.info(`📤 Sent contract-created to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
    }

    if (msg.role === 'contract-created' && msg.to === node.peerId.toString()) {
      // Sign the contract and send back to customer with role "contract-signed"
      const contractCreatedMsg = msg as ContractCreated;
      await algo.fundQuote({
        quoteId: contractCreatedMsg.id,
        usdcAmount: BigInt(contractCreatedMsg.payload.quote.totalPrice * 1_000_000),
      });

      let response: ContractSigned = {
        ...contractCreatedMsg,
        role: "contract-signed",
      };
      contractCreatedMsg.signature = await algo.signObject(contractCreatedMsg);
      node.services.pubsub.publish('diiisco/models/1.0.0', encode(response));
      logger.info(`📤 Sent contract-signed to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
    }
    
    if (msg.role === 'contract-signed' && msg.to === node.peerId.toString()) {
      const contractSignedMsg = msg as ContractSigned;
      const funded = await algo.verifyQuoteFunded(contractSignedMsg.id);
      if (!funded.funded || funded.usdcAmount < BigInt(contractSignedMsg.payload.quote.totalPrice * 1_000_000)) {
        logger.warn(`❌ Contract ${contractSignedMsg.id} is not funded. Cannot proceed with inference.`);
        return;
      }
      
      //Execute Inference and send back to customer with role "inference-response"
      const completion = await model.getResponse(contractSignedMsg.payload.model, contractSignedMsg.payload.inputs);
      let response: InferenceResponse = {
        role: 'inference-response',
        to: evt.detail.from.toString(),
        timestamp: Date.now(),
        id: contractSignedMsg.id,
        fromWalletAddr: env.algorand.addr,
        payload: {
          ...contractSignedMsg.payload,
          completion: completion,
        }
      };

      response.signature = await algo.signObject(response);
      node.services.pubsub.publish('diiisco/models/1.0.0', encode(response));
      logger.info(`📤 Sent inference-response to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
    }

    if (msg.role === 'inference-response' && msg.to === node.peerId.toString()) {
      const inferenceResponseMsg = msg as InferenceResponse;
      logger.info(`📥 Received inference-response: ${JSON.stringify(inferenceResponseMsg)}`);
      const payment = await algo.completeQuote({ quoteId: inferenceResponseMsg.id });
      nodeEvents.emit(`inference-response-${inferenceResponseMsg.id}`, { ...inferenceResponseMsg, payment: payment, quote: inferenceResponseMsg.payload.quote });
    }
  }
};