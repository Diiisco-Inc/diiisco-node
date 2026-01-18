import express from 'express';
import cors from "cors";
import { requireBearer } from "../utils/endpoint";
import environment from "../environment/environment";
import { sha256 } from "js-sha256";
import { EventEmitter } from 'events';
import { encode } from "msgpackr";
import { QuoteRequest, QuoteAccepted, InferenceResponse, QuoteResponse, ListModelsResponse, ListModelsRequest } from "../types/messages";
import { logger } from '../utils/logger';
import { waitForMesh } from '../libp2p/node';
import { Libp2p } from '@libp2p/interface';
import { Connection } from 'libp2p-tcp';
import algorand from '../utils/algorand';
import { MessageRouter } from '../messaging/messageRouter';

export const createApiServer = (node: Libp2p, nodeEvents: EventEmitter, algo: algorand, messageRouter: MessageRouter) => {
  const app = express();
  const port = environment.api.port || 8080;
  app.use(cors());
  app.use(express.json());

  if (environment.api.bearerAuthentication) {
    app.use("/v1", requireBearer);
    app.use("/peers", requireBearer);
  }

  app.get('/health', (req, res) => {
    res.status(200).send('API is healthy');
  });

  app.get('/peers', async (req, res) => {
    try {
      const peers = node.getConnections().map((conn: Connection) => {
        return {
          remoteAddr: conn.remoteAddr.toString(),
          peerId: conn.remotePeer.toString()
        };
      });
      res.status(200).send({ peers });
    } catch (error) {
      logger.error("Error fetching peers:", error);
      res.status(500).send({ error: "Error fetching peers" });
    }
  });

  app.get('/v1/models', async (req, res) => {
    try {
      nodeEvents.once('model-list-compiled', (response: ListModelsResponse) => {
        res.status(200).send({
            "object": "list",
            "data": response,
        });
      });

      const modelListMessage: ListModelsRequest = {
       role: "list-models",
        timestamp: Date.now(),
        id: sha256(Date.now().toString() + JSON.stringify(req.body)).slice(0, 56),
        fromWalletAddr: environment.algorand.addr,
      };

      modelListMessage.signature = await algo.signObject(modelListMessage);

      waitForMesh(node, "diiisco/models/1.0.0", { min: 1, timeoutMs: 5000 }).then(async () => {
        await messageRouter.sendMessage(modelListMessage);
        logger.info(`📤 Published message to 'diiisco/models/1.0.0'. ID: ${modelListMessage.id}`);
      }).catch((err: string) => {
        logger.error(`❌ Error waiting for mesh before publishing: ${err}`);
        return res.status(500).send({ error: "No peers available to handle the request." });
      });
    } catch (error) {
      logger.error("Error fetching models:", error);
      res.status(500).send({ error: "Error fetching models" });
    }
  })

  app.post(`/v1/chat/completions`, async (req, res) => {
    logger.info("🚀 Received /v1/chat/completions request.");
    if (!req.body || !req.body.model || (!req.body.messages && !req.body.inputs)) {
      logger.warn("Missing model or messages in request body.");
      return res.status(400).send({ error: "Missing model or messages in request body." });
    };

    if (req.body.messages) {
      req.body.inputs = req.body.messages;
      delete req.body.messages;
    }
    
    const quoteMessage: QuoteRequest = {
      role: "quote-request",
      from: node.peerId.toString(),
      fromWalletAddr: environment.algorand.addr,
      timestamp: Date.now(),
      id: sha256(Date.now().toString() + JSON.stringify(req.body)).slice(0, 56),
      payload: {
        ...req.body
      }
    };

    quoteMessage.signature = await algo.signObject(quoteMessage);

    waitForMesh(node, "diiisco/models/1.0.0", { min: 1, timeoutMs: 5000 }).then(async () => {
      await messageRouter.sendMessage(quoteMessage);
      logger.info(`📤 Published message to 'diiisco/models/1.0.0'. ID: ${quoteMessage.id}`);
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
        to: quote.from.toString(),
        timestamp: Date.now(),
        id: quote.msg.id,
        fromWalletAddr: environment.algorand.addr,
        payload: {
          ...quote.msg.payload,
        }
      };

      acceptance.signature = await algo.signObject(acceptance);
      await messageRouter.sendMessage(acceptance, quote.from.toString());
      logger.info(`📤 Sent quote-accepted to ${quote.from.toString()}`);
    });
  });

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`🚀 API server listening at ${environment.node?.url || `http://0.0.0.0:${port || 8080}`}`);
  });

  return { app, server };
};