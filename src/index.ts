import { createLibp2pNode } from './libp2p/node';
import { createApiServer } from './api/server';
import { handlePubSubMessage } from './pubsub/handler';
import { EventEmitter } from 'events';
import algorand from "./utils/algorand";
import environment from "./environment/environment";
import { Environment } from "./environment/environment.types";
import { OpenAIInferenceModel } from "./utils/models";
import quoteEngine from "./utils/quoteEngine";
import OpenAI from "openai";
import { logger } from './utils/logger';

class Application extends EventEmitter {
  private node: any; // TODO: Replace 'any' with a specific Libp2p node type
  private algo: algorand;
  private model: OpenAIInferenceModel;
  private quoteMgr: quoteEngine;
  private topics: string[] = [];
  private env: Environment; // Explicitly type the environment

  constructor() {
    super();
    this.env = environment; // Assign the imported environment
    this.algo = new algorand();
    this.model = new OpenAIInferenceModel(`${this.env.models.baseURL}:${this.env.models.port}/v1`);
    this.quoteMgr = new quoteEngine(this); // Pass 'this' (Application instance) as EventEmitter
  }

  async start() {
    await this.algo.initialize(); // Initialize Algorand here
    this.node = await createLibp2pNode();
    this.topics.push(this.node.peerId.toString());
    this.node.services.pubsub.subscribe(this.node.peerId.toString()); // Subscribe to own peer ID for direct messages

    if (this.env.api.enabled) {
      createApiServer(this.node, this); // Pass 'this' (Application instance) as EventEmitter
    }

    if (this.env.models.enabled) {
      const models = await this.model.getModels();
      this.node.services.pubsub.subscribe('models'); // Subscribe to general models topic
      models.filter((m: OpenAI.Models.Model) => m.object == 'model').forEach((modelInfo: OpenAI.Models.Model) => {
        this.node.services.pubsub.subscribe(`models/${modelInfo.id}`); // Subscribe to specific model topics
        this.topics.push(`models/${modelInfo.id}`);
        logger.info(`🤖 Serving Model: ${modelInfo.id}`);
      });
    }

    this.node.services.pubsub.addEventListener('message', async (evt: { detail: { topic: string; data: Uint8Array; from: any; }; }) => { // TODO: Define a proper type for evt
      await handlePubSubMessage(evt, this.node, this, this.algo, this.model, this.quoteMgr, this.topics);
    });

    this.node.addEventListener('peer:discovery', async (e: { detail: { id: any; }; }) => { // TODO: Define a proper type for e
      const id = e.detail.id
      logger.info('👋 Discovered Peer:', id.toString())
      try { await this.node.dial(id); logger.info('✅ Connected to Peer:', id.toString()) } catch (err) {
        logger.error('❌ Failed to connect to peer:', err);
      }
    });
  }
}

const app = new Application();
app.start().catch(err => {
  if (err.message === "PeerID not found.") {
    logger.error('🚨 Application failed to start: PeerID not found in environment.ts. Please generate one using \'npm run get-peer-id\' and add it to environment.ts.');
  } else {
    logger.error('🚨 Application failed to start:', err);
  }
  process.exit(1);
});