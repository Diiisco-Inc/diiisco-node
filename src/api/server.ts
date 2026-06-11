import express from 'express';
import cors from "cors";
import { requireBearer } from "../utils/endpoint";
import environment from "../environment/environment";
import { sha256 } from "js-sha256";
import { EventEmitter } from 'events';
import { encode } from "msgpackr";
import { QuoteRequest, QuoteAccepted, InferenceResponse, QuoteResponse, ListModelsResponse, ListModelsRequest, ListNetworkRequest, NetworkNode } from "../types/messages";
import { logger } from '../utils/logger';
import { Libp2p } from '@libp2p/interface';
import { MeshMessageQueue } from '../messaging/meshMessageQueue';
import { Connection } from 'libp2p-tcp';
import algorand from '../utils/algorand';
import { MessageRouter } from '../messaging/messageRouter';
import { OpenAIInferenceModel } from '../utils/models';

export const createApiServer = (node: Libp2p, nodeEvents: EventEmitter, algo: algorand, messageRouter: MessageRouter, meshQueue: MeshMessageQueue, model?: OpenAIInferenceModel, availableModels?: string[]) => {
  const app = express();
  const port = environment.api.port || 8080;
  app.use(cors());
  app.use(express.json());

  if (environment.api.bearerAuthentication) {
    app.use("/v1", requireBearer);
    app.use("/peers", requireBearer);
    app.use("/network", requireBearer);
    app.use("/health/algorand", requireBearer);
  }

  app.get('/health', (req, res) => {
    res.status(200).send('API is healthy');
  });

  app.get('/health/algorand', async (req, res) => {
    try {
      const diagnostics = await algo.getDiagnostics();
      const ok = diagnostics.localMode
        || (diagnostics.algodReachable && diagnostics.contractRegistered);
      res.status(ok ? 200 : 503).json(diagnostics);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/peers', async (req, res) => {
    try {
      const peers = node.getConnections().map((conn: Connection) => {
        return {
          remoteAddr: conn.remoteAddr.toString(),
          peerId: conn.remotePeer.toString(),
        };
      });
      res.status(200).send({ peers });
    } catch (error) {
      logger.error("Error fetching peers:", error);
      res.status(500).send({ error: "Error fetching peers" });
    }
  });

  app.get('/network', async (req, res) => {
    try {
      const nodes: NetworkNode[] = [];
      const waitTime = environment.api?.networkWaitTime || 5000;

      const onNodeReceived = (node: NetworkNode) => {
        nodes.push(node);
      };
      nodeEvents.on('network-node-received', onNodeReceived);

      const networkListMessage: ListNetworkRequest = {
        role: "list-network",
        timestamp: Date.now(),
        id: sha256(Date.now().toString() + JSON.stringify(req.body)).slice(0, 56),
        fromWalletAddr: algo.account.addr.toString(),
      };
      networkListMessage.signature = await algo.signObject(networkListMessage);

      meshQueue.enqueue(networkListMessage).then(() => {
        logger.info(`📤 Published message to 'diiisco/models/1.0.0'. ID: ${networkListMessage.id}`);

        setTimeout(() => {
          nodeEvents.off('network-node-received', onNodeReceived);
          res.status(200).send({
            "object": "list",
            "data": nodes,
          });
        }, waitTime);
      }).catch((err: Error) => {
        nodeEvents.off('network-node-received', onNodeReceived);
        logger.error(`❌ Error dispatching network list message: ${err}`);
        return res.status(500).send({ error: "No peers available to handle the request." });
      });
    } catch (error) {
      logger.error("Error fetching network:", error);
      res.status(500).send({ error: "Error fetching network" });
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
        fromWalletAddr: algo.account.addr.toString(),
      };

      modelListMessage.signature = await algo.signObject(modelListMessage);

      meshQueue.enqueue(modelListMessage).then(() => {
        logger.info(`📤 Published message to 'diiisco/models/1.0.0'. ID: ${modelListMessage.id}`);
      }).catch((err: Error) => {
        logger.error(`❌ Error dispatching model list message: ${err}`);
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

    const preferSelf = environment.quoteEngine.preferSelf !== false;
    if (preferSelf && model && availableModels?.includes(req.body.model)) {
      logger.info(`⚡ Serving request locally (preferSelf). Model: ${req.body.model}`);
      const completion = await model.getResponse(req.body.model, req.body.inputs);
      return res.status(200).send(completion);
    }

    const quoteMessage: QuoteRequest = {
      role: "quote-request",
      from: node.peerId.toString(),
      fromWalletAddr: algo.account.addr.toString(),
      timestamp: Date.now(),
      id: sha256(Date.now().toString() + JSON.stringify(req.body)).slice(0, 56),
      payload: {
        ...req.body
      }
    };

    quoteMessage.signature = await algo.signObject(quoteMessage);

    meshQueue.enqueue(quoteMessage).then(() => {
      logger.info(`📤 Published message to 'diiisco/models/1.0.0'. ID: ${quoteMessage.id}`);
    }).catch((err: Error) => {
      logger.error(`❌ Error dispatching quote request: ${err}`);
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
        fromWalletAddr: algo.account.addr.toString(),
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