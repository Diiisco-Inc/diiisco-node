import { decode, encode } from "msgpackr";
import { EventEmitter } from 'events';
import algorand from "../utils/algorand";
import environment from "../environment/environment";
import { OpenAIInferenceModel } from "../utils/models";
import quoteEngine from "../utils/quoteEngine";
import { PubSubMessage, QuoteRequest, QuoteResponse, QuoteAccepted, InferenceResponse } from "../types/messages";
import { logger } from '../utils/logger';
import { Environment } from "../environment/environment.types";

export const handlePubSubMessage = async (
  evt: any,
  node: any,
  nodeEvents: EventEmitter,
  algo: algorand,
  model: OpenAIInferenceModel,
  quoteMgr: quoteEngine,
  topics: string[]
) => {
  if (topics.includes(evt.detail.topic)) {
    const msg: PubSubMessage = decode(evt.detail.data);
    const env: Environment = environment; // Use the typed environment

    if  (evt.detail.topic === 'diiisco-relay') {
      // Ignore messages on the relay topic that are from self
      if (evt.detail.from.toString() === node.peerId.toString()) {
        return;
      }

      const relaySubMsg = msg as unknown as { role: 'relay-subscribe'; topic: string; };
      if (!topics.includes(relaySubMsg.topic)) {
        node.services.pubsub.subscribe(relaySubMsg.topic);
        topics.push(relaySubMsg.topic);
        logger.info(`✅ Subscribed to topic '${relaySubMsg.topic}' from relay request.`);
        node.services.pubsub.publish('diiisco-relay', encode({ role: 'relay-subscribe', topic: relaySubMsg.topic }));
      }
      return;
    }

    // If Models are Disabled, this is a relay node and we do not process messages further
    if (environment.models.enabled === false) {
      return;
    }

    if (msg.role === 'quote-request') {
      const quoteRequestMsg = msg as QuoteRequest;
      const x = await algo.checkIfOptedIn(quoteRequestMsg.paymentSourceAddr, env.algorand.paymentAssetId);
      if (!x.optedIn || Number(x.balance) <= 0) {
        logger.warn(`❌ Quote request from ${quoteRequestMsg.paymentSourceAddr} cannot be fulfilled - not opted in or zero balance.`);
        return;
      }

      const tokenCount: number = await model.countEmbeddings(quoteRequestMsg.payload.model, quoteRequestMsg.payload.inputs);
      const modelRate = env.models.chargePer1KTokens[quoteRequestMsg.payload.model] || env.models.chargePer1KTokens.default || 0.000001;
      let response: QuoteResponse = {
        role: 'quote-response',
        timestamp: Date.now(),
        id: quoteRequestMsg.id,
        paymentSourceAddr: env.algorand.addr,
        payload: {
          ...quoteRequestMsg.payload,
          quote: {
            model: quoteRequestMsg.payload.model,
            inputCount: quoteRequestMsg.payload.inputs.length,
            tokenCount: tokenCount,
            pricePer1K: modelRate,
            totalPrice: (tokenCount / 1000) * modelRate,
            addr: algo.addr,
          },
          signature: ''
        }
      };

      response.payload.signature = await algo.signObject(response.payload.quote);
      node.services.pubsub.publish(evt.detail.from.toString(), encode(response));
      logger.info(`📤 Sent quote-response to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
    }

    if (msg.role === 'quote-response') {
      const quoteResponseMsg = msg as QuoteResponse;
      logger.info(`📥 Received quote-response: ${JSON.stringify(quoteResponseMsg)}`);
      quoteMgr.addQuote({ msg: quoteResponseMsg, from: evt.detail.from.toString() });
    }

    if (msg.role === 'quote-accepted') {
      const quoteAcceptedMsg = msg as QuoteAccepted;
      const validQuote: boolean = await algo.verifySignature(quoteAcceptedMsg.payload.quote, quoteAcceptedMsg.payload.signature);
      if (validQuote) {
        const completion = await model.getResponse(quoteAcceptedMsg.payload.model, quoteAcceptedMsg.payload.inputs);
        let response: InferenceResponse = {
          role: 'inference-response',
          timestamp: Date.now(),
          id: quoteAcceptedMsg.id,
          paymentSourceAddr: env.algorand.addr,
          payload: {
            ...quoteAcceptedMsg.payload,
            completion: completion,
          }
        };
        
        node.services.pubsub.publish(evt.detail.from.toString(), encode(response));
        logger.info(`📤 Sent inference-response to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
      }
    }

    if (msg.role === 'inference-response') {
      const inferenceResponseMsg = msg as InferenceResponse;
      logger.info(`📥 Received inference-response: ${JSON.stringify(inferenceResponseMsg)}`);
      const payment = await algo.makePayment(inferenceResponseMsg.payload.quote.addr, inferenceResponseMsg.payload.quote.totalPrice);
      nodeEvents.emit(`inference-response-${inferenceResponseMsg.id}`, { ...inferenceResponseMsg, payment: payment, quote: inferenceResponseMsg.payload.quote });
    }
  }
};