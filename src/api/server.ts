import express from 'express';
import cors from "cors";
import { requireBearer } from "../utils/endpoint";
import environment from "../environment/runtime";
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
import { OpenAIInferenceModel, pickGenerationParams, countInputTokens } from '../utils/models';
import { ModelAvailability } from '../utils/modelAvailability';
import OpenAI from 'openai';
import {
  validateMessagesRequest,
  validateCountTokensRequest,
  anthropicToOpenAIInputs,
  openAIToAnthropicMessage,
  streamAnthropicMessage,
  anthropicError,
  AnthropicMessagesRequest,
} from './anthropicAdapter';
import { getMeshTopic } from '../utils/topic';
import { registerStatusPages } from './statusPages';
import { nodeStats } from '../utils/nodeStats';
import {
  NoProviderError,
  InferenceTimeoutError,
  statusForInferenceError,
  messageForInferenceError,
} from './inferenceErrors';

export const createApiServer = (node: Libp2p, nodeEvents: EventEmitter, algo: algorand, messageRouter: MessageRouter, meshQueue: MeshMessageQueue, model?: OpenAIInferenceModel, models?: ModelAvailability) => {
  const app = express();
  const port = environment.api.port || 8080;
  app.use(cors());
  // Express's json() defaults to a 100kb body limit — easily exceeded by a real
  // agent request (system prompt + full tool schemas + conversation history),
  // which throws PayloadTooLargeError before this app's own routes ever see the
  // request. Raised well below the 32MB ceiling clients like Claude Code apply
  // on their own end, so DIIISCO's own limit is never the thing that trips first.
  app.use(express.json({ limit: '25mb' }));

  if (environment.api.bearerAuthentication) {
    app.use("/v1", requireBearer);
    app.use("/peers", requireBearer);
    app.use("/network", requireBearer);
    app.use("/health/algorand", requireBearer);
  }

  // Public status pages (unauthenticated by design — see src/api/statusPages.ts)
  if (environment.node?.statusPages !== false) {
    registerStatusPages({ app, node, nodeEvents, algo, messageRouter, models });
  }

  app.get('/health', (req, res) => {
    res.status(200).send('API is healthy');
  });

  app.get('/health/algorand', async (req, res) => {
    try {
      const diagnostics = await algo.getDiagnostics();
      // Healthy on the public network when algod is reachable and the wallet is
      // opted into USDC (required to settle x402 payments).
      const ok = diagnostics.localMode
        || (diagnostics.algodReachable && !!diagnostics.usdc?.optedIn);
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
        logger.info(`📤 Published message to '${getMeshTopic()}'. ID: ${networkListMessage.id}`);

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
      // `model-list-compiled` only ever fires once some peer replies, so an
      // unanswered broadcast used to hang this route too. Fall back to what
      // this node itself serves once the collection window has passed.
      const listWaitTime = environment.api?.networkWaitTime || 10000;
      let answered = false;
      let fallbackTimer: ReturnType<typeof setTimeout>;

      const onCompiled = (response: ListModelsResponse) => {
        if (answered) return;
        answered = true;
        clearTimeout(fallbackTimer);
        res.status(200).send({
            "object": "list",
            "data": response,
        });
      };
      nodeEvents.once('model-list-compiled', onCompiled);

      fallbackTimer = setTimeout(() => {
        if (answered) return;
        answered = true;
        nodeEvents.off('model-list-compiled', onCompiled);
        res.status(200).send({
          "object": "list",
          "data": models?.models() ?? [],
        });
      }, listWaitTime);

      const modelListMessage: ListModelsRequest = {
       role: "list-models",
        timestamp: Date.now(),
        id: sha256(Date.now().toString() + JSON.stringify(req.body)).slice(0, 56),
        fromWalletAddr: algo.account.addr.toString(),
      };

      modelListMessage.signature = await algo.signObject(modelListMessage);

      meshQueue.enqueue(modelListMessage).then(() => {
        logger.info(`📤 Published message to '${getMeshTopic()}'. ID: ${modelListMessage.id}`);
      }).catch((err: Error) => {
        logger.error(`❌ Error dispatching model list message: ${err}`);
        if (answered) return;
        answered = true;
        clearTimeout(fallbackTimer);
        nodeEvents.off('model-list-compiled', onCompiled);
        return res.status(500).send({ error: "No peers available to handle the request." });
      });
    } catch (error) {
      logger.error("Error fetching models:", error);
      res.status(500).send({ error: "Error fetching models" });
    }
  })

  /**
   * Run an inference request expressed in the internal OpenAI shape
   * (`{ model, inputs, ...generationParams }`) and resolve to a raw OpenAI
   * ChatCompletion. Shared by the OpenAI (`/v1/chat/completions`) and
   * Anthropic (`/v1/messages`) API layers so dispatch stays identical.
   *
   * If `preferSelf` and the model is available locally, inference runs
   * directly; otherwise it goes through the mesh quote auction and resolves
   * when the matching `inference-response` arrives.
   */
  /** How long to wait for the auction to pick a quote before giving up. */
  const auctionTimeoutMs = (): number =>
    environment.quoteEngine.auctionTimeout ?? (environment.quoteEngine.waitTime || 1000) + 5000;

  /** Overall deadline for one auction attempt, end to end. */
  const inferenceTimeoutMs = (): number => environment.quoteEngine.inferenceTimeout ?? 300_000;

  /**
   * One trip through the mesh auction: broadcast a quote-request, accept the
   * selected quote, and resolve when the answer comes back.
   *
   * Two deadlines bound it, because nothing else does — a provider whose
   * backend has stopped simply stops talking, and without these the HTTP
   * request hung forever:
   *
   *  - the **auction** deadline fires if no quote is selected, meaning nobody
   *    on the network is serving the model (→ `NoProviderError`, 503);
   *  - the **overall** deadline covers the whole quote → accept → contract →
   *    answer choreography (→ `InferenceTimeoutError`, 504).
   *
   * Every exit path runs `cleanup()`, so listeners and timers never outlive
   * the request that made them.
   */
  const runAuction = async (
    body: any,
    attempt: number
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
    const quoteMessage: QuoteRequest = {
      role: "quote-request",
      from: node.peerId.toString(),
      fromWalletAddr: algo.account.addr.toString(),
      timestamp: Date.now(),
      // The attempt number keeps a retry's id distinct from the attempt it
      // replaces, so their events and listeners can't collide.
      id: sha256(`${Date.now()}:${attempt}:${JSON.stringify(body)}`).slice(0, 56),
      // Broadcast to every provider — so it carries only what's needed to quote:
      // the model, our own input-token count, budget, and output cap. The prompt
      // content stays local and goes only to the winning provider (quote-accepted),
      // and so do the tool schemas — but they are counted here, because an agent
      // tool's schemas are thousands of tokens the provider must be paid for.
      payload: {
        model: body.model,
        inputTokenCount: countInputTokens(body.inputs, body.tools),
        max_tokens: body.max_tokens,
        maxSpend: environment.algorand?.settlement?.maxSpend,
      }
    };

    quoteMessage.signature = await algo.signObject(quoteMessage);
    const id = quoteMessage.id;

    return await new Promise<OpenAI.Chat.Completions.ChatCompletion>((resolve, reject) => {
      let settled = false;
      let quoteSelected = false;
      let auctionTimer: ReturnType<typeof setTimeout> | undefined;
      let overallTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        nodeEvents.off(`inference-response-${id}`, onResponse);
        nodeEvents.off(`quote-selected-${id}`, onSelected);
        clearTimeout(auctionTimer);
        clearTimeout(overallTimer);
      };

      // Exactly one outcome per attempt, and it always tidies up after itself.
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };

      function onResponse(response: InferenceResponse) {
        settle(() => resolve(response.payload.completion));
      }

      async function onSelected(quote: { msg: QuoteResponse, from: string }) {
        quoteSelected = true;
        clearTimeout(auctionTimer);
        if (settled) return;

        logger.info(`✅ Quote selected for request ID ${id}. Served by ${quote.from.toString()}. Sending quote-accepted message.`);

        // Negotiate settlement: pick our highest-preference method the provider
        // also offers. Escrow has been retired, so x402 is the only method.
        const providerMethods = quote.msg.payload?.quote?.settlementMethods ?? ['x402'];
        const localPreference = environment.algorand?.settlement?.methods ?? ['x402'];
        const settlementMethod = localPreference.find((m) => providerMethods.includes(m)) ?? providerMethods[0];

        let acceptance: QuoteAccepted = {
          role: 'quote-accepted',
          to: quote.from.toString(),
          timestamp: Date.now(),
          id: quote.msg.id,
          fromWalletAddr: algo.account.addr.toString(),
          // Sent directly to the winning provider only — so this is where the
          // prompt content (body) is revealed, alongside the selected quote.
          payload: {
            ...body,
            ...quote.msg.payload,
            settlementMethod,
          }
        };

        try {
          acceptance.signature = await algo.signObject(acceptance);
          await messageRouter.sendMessage(acceptance, quote.from.toString());
          logger.info(`📤 Sent quote-accepted to ${quote.from.toString()}`);
        } catch (err) {
          settle(() => reject(err as Error));
        }
      }

      nodeEvents.once(`inference-response-${id}`, onResponse);
      nodeEvents.once(`quote-selected-${id}`, onSelected);

      const overallMs = inferenceTimeoutMs();
      overallTimer = setTimeout(
        () => settle(() => reject(new InferenceTimeoutError(body.model, overallMs))),
        overallMs
      );

      meshQueue.enqueue(quoteMessage).then(() => {
        logger.info(`📤 Published message to '${getMeshTopic()}'. ID: ${id}`);
        // Armed only once the request is actually on the wire, and skipped if a
        // quote somehow beat us to it.
        if (!settled && !quoteSelected) {
          auctionTimer = setTimeout(
            () => settle(() => reject(new NoProviderError(body.model))),
            auctionTimeoutMs()
          );
        }
      }).catch((err: Error) => {
        logger.error(`❌ Error dispatching quote request: ${err}`);
        settle(() => reject(err));
      });
    });
  };

  const runInference = async (body: any): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
    const params = pickGenerationParams(body);
    nodeStats.inferencesRequested++;

    const preferSelf = environment.quoteEngine.preferSelf !== false;
    // Verified live: a node whose backend has stopped used to short-circuit to
    // itself and 500, rather than letting a peer that can serve the model win.
    if (preferSelf && model && models && await models.ensureAvailable(body.model)) {
      logger.info(`⚡ Serving request locally (preferSelf). Model: ${body.model}`);
      return model.getResponse(body.model, body.inputs, params);
    }

    return runAuction(body, 1);
  };

  app.post(`/v1/chat/completions`, async (req, res) => {
    const requestStartedAt = Date.now();
    logger.info("🚀 Received /v1/chat/completions request.");
    if (!req.body || !req.body.model || (!req.body.messages && !req.body.inputs)) {
      logger.warn("Missing model or messages in request body.");
      return res.status(400).send({ error: "Missing model or messages in request body." });
    };

    if (req.body.messages) {
      req.body.inputs = req.body.messages;
      delete req.body.messages;
    }

    try {
      const completion = await runInference(req.body);
      const elapsed = ((Date.now() - requestStartedAt) / 1000).toFixed(2);
      logger.info(`🚀 Sending inference response in ${elapsed}s`);
      return res.status(200).send(completion);
    } catch (err) {
      // 503 when nothing on the network serves the model, 504 on a deadline —
      // a specific status and message is what tells an operator their backend
      // is off, instead of a request that never returns.
      const status = statusForInferenceError(err);
      const message = messageForInferenceError(err);
      logger.warn(`❌ /v1/chat/completions failed (${status}): ${message}`);
      return res.status(status).send({ error: message });
    }
  });

  app.post(`/v1/messages`, async (req, res) => {
    const requestStartedAt = Date.now();
    logger.info("🚀 Received /v1/messages request.");

    const validationError = validateMessagesRequest(req.body);
    if (validationError) {
      logger.warn(`Invalid /v1/messages request: ${validationError.error.message}`);
      return res.status(400).json(validationError);
    }

    const { model: reqModel, inputs, params } = anthropicToOpenAIInputs(req.body as AnthropicMessagesRequest);

    try {
      const completion = await runInference({ model: reqModel, inputs, ...params });
      const elapsed = ((Date.now() - requestStartedAt) / 1000).toFixed(2);

      // Claude Code always sends stream: true and has no way to be told not
      // to. The backend call above is already non-streaming, so the full
      // response exists by this point — streaming just re-frames it as SSE
      // rather than doing real incremental generation (see plan 005).
      if (req.body.stream === true) {
        streamAnthropicMessage(res, completion, reqModel);
        logger.info(`🚀 Sent Anthropic message response (streamed) in ${elapsed}s`);
        return;
      }

      const anthropicMessage = openAIToAnthropicMessage(completion, reqModel);
      logger.info(`🚀 Sending Anthropic message response in ${elapsed}s`);
      return res.status(200).json(anthropicMessage);
    } catch (err) {
      const status = statusForInferenceError(err);
      const message = messageForInferenceError(err);
      logger.warn(`❌ /v1/messages failed (${status}): ${message}`);
      return res.status(status).json(anthropicError("api_error", message));
    }
  });

  app.post(`/v1/messages/count_tokens`, async (req, res) => {
    const validationError = validateCountTokensRequest(req.body);
    if (validationError) {
      return res.status(400).json(validationError);
    }

    if (!model) {
      return res.status(503).json(
        anthropicError("api_error", "Token counting requires a local model backend on this node.")
      );
    }

    const { model: reqModel, inputs, params } = anthropicToOpenAIInputs(req.body as AnthropicMessagesRequest);
    const input_tokens = await model.countEmbeddings(reqModel, inputs, params.tools);
    return res.status(200).json({ input_tokens });
  });

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`🚀 API server listening at ${environment.node?.url || `http://0.0.0.0:${port || 8080}`}`);
  });

  return { app, server };
};