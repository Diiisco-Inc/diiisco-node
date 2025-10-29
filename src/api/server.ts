import express from 'express';
import cors from "cors";
import { requireBearer } from "../utils/endpoint";
import environment from "../environment/environment";
import { sha256 } from "js-sha256";
import { EventEmitter } from 'events';
import { encode } from "msgpackr";
import { QuoteRequest, QuoteAccepted, InferenceResponse, QuoteResponse } from "../types/messages";
import { logger } from '../utils/logger';
import { waitForMesh } from '../libp2p/node';

export const createApiServer = (node: any, nodeEvents: EventEmitter) => {
  const app = express();
  const port = environment.api.port || 8080;
  app.use(cors());
  app.use(express.json());

  if (environment.api.bearerAuthentication) {
    app.use("/v1", requireBearer);
  }

  app.get('/health', (req, res) => {
    res.status(200).send('API is healthy');
  });

  app.post(`/v1/chat/completions`, async (req, res) => {
    logger.info("🚀 Received /v1/chat/completions request.");
    if (!req.body || !req.body.model || !req.body.inputs) {
      logger.warn("Missing model or messages in request body.");
      return res.status(400).send({ error: "Missing model or messages in request body." });
    };

    const quoteMessage: QuoteRequest = {
      role: "quote-request",
      from: node.peerId.toString(),
      paymentSourceAddr: environment.algorand.addr,
      timestamp: Date.now(),
      id: `${Date.now()}-${sha256(JSON.stringify(req.body))}`,
      payload: {
        ...req.body
      }
    };

    waitForMesh(node, `models/${req.body.model}`, { min: 1, timeoutMs: 5000 }).then(() => {
      node.services.pubsub.publish(`models/${req.body.model}`, encode(quoteMessage));
      logger.info(`📤 Published message to 'models/${req.body.model}'. ID: ${quoteMessage.id}`);
    }).catch((err: string) => {
      logger.error(`❌ Error waiting for mesh before publishing: ${err}`);
      return res.status(500).send({ error: "No peers available to handle the request." });
    });

    nodeEvents.once(`inference-response-${quoteMessage.id}`, (response: InferenceResponse) => {
      logger.info(`🚀 Sending inference response for request ID ${quoteMessage.id}:`, response);
      res.status(200).send(response.payload.completion);
    });

    nodeEvents.once(`quote-selected-${quoteMessage.id}`, async (quote: { msg: QuoteResponse, from: string }) => {
      logger.info(`✅ Quote selected for request ID ${quoteMessage.id}:`, quote.msg);

      let acceptance: QuoteAccepted = {
        role: 'quote-accepted',
        timestamp: Date.now(),
        id: quote.msg.id,
        paymentSourceAddr: environment.algorand.addr,
        payload: {
          ...quote.msg.payload,
        }
      };

      node.services.pubsub.publish(quote.from.toString(), encode(acceptance));
      logger.info(`📤 Sent quote-accepted to ${quote.from.toString()}: ${JSON.stringify(acceptance)}`);
    });
  });

  app.listen(port, '0.0.0.0', () => {
    logger.info(`🚀 API server listening at ${environment.node?.url || `http://0.0.0.0:${port || 8080}`}`);
  });

  return app;
};