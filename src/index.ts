import { createLibp2pNode, lookupBootstrapServers } from './libp2p/node';
import { ReconnectionDependencies, scheduleReconnect, attemptReconnect, reconnectToBootstrap, startConnectionHealthCheck } from './libp2p/reconnection';
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
  private node: any;
  private algo: algorand;
  private model: OpenAIInferenceModel;
  private availableModels: string[] = [];
  private quoteMgr: quoteEngine;
  private topics: string[] = [];
  private env: Environment;
  
  // Track peers for reconnection
  private knownPeers: Map<string, { lastSeen: number; multiaddrs: string[] }> = new Map();
  private reconnectAttempts: Map<string, { count: number; lastAttempt: number }> = new Map();
  private bootstrapAddresses: string[] = [];
  
  // Configuration
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds base delay
  private readonly RECONNECT_COOLDOWN = 300000; // 5 minutes before resetting attempts
  private readonly MIN_CONNECTIONS = 2;
  
  // Track last health check state to reduce log spam
  public lastConnectionCount = -1;
  public lastBootstrapAttempt = 0;
  private readonly BOOTSTRAP_RETRY_INTERVAL = 120000; // Retry bootstrap every 2 minutes when disconnected

  constructor() {
    super();
    this.env = environment;
    this.algo = new algorand();
    this.model = new OpenAIInferenceModel(`${this.env.models.baseURL}:${this.env.models.port}/v1`, this);
    this.quoteMgr = new quoteEngine(this);
  }
  
  private createReconnectionDependencies(): ReconnectionDependencies {
    return {
      reconnectAttempts: this.reconnectAttempts,
      RECONNECT_COOLDOWN: this.RECONNECT_COOLDOWN,
      MAX_RECONNECT_ATTEMPTS: this.MAX_RECONNECT_ATTEMPTS,
      RECONNECT_DELAY: this.RECONNECT_DELAY,
      attemptReconnect: async (peerId: string) => await attemptReconnect(peerId, this.createReconnectionDependencies()),
      node: this.node,
      knownPeers: this.knownPeers,
      MIN_CONNECTIONS: this.MIN_CONNECTIONS,
      BOOTSTRAP_RETRY_INTERVAL: this.BOOTSTRAP_RETRY_INTERVAL,
      lastBootstrapAttempt: this.lastBootstrapAttempt,
      bootstrapAddresses: this.bootstrapAddresses,
      lastConnectionCount: this.lastConnectionCount,
    };
  }

  async start() {
    // Load bootstrap server addresses for reconnection
    this.bootstrapAddresses = await lookupBootstrapServers();
    logger.info(`🌐 Loaded ${this.bootstrapAddresses.length} bootstrap server(s)`);
    
    // Create and Start the Libp2p Node
    this.node = await createLibp2pNode();
    
    // Initialize Algorand for DSCO Payments
    await this.algo.initialize(this.node.peerId.toString());

    // Create a Relay PubSub Topic
    this.node.services.pubsub.subscribe('diiisco/models/1.0.0');
    this.topics.push('diiisco/models/1.0.0');

    // Start the API Server
    if (this.env.api.enabled) {
      createApiServer(this.node, this, this.algo);
    }

    // Listen for Model PubSub Events
    if (this.env.models.enabled) {
      const models = await this.model.getModels();
      this.availableModels = models.filter((m: OpenAI.Models.Model) => m.object == 'model').map((modelInfo: OpenAI.Models.Model) => {
        logger.info(`🤖 Serving Model: ${modelInfo.id}`);
        return modelInfo.id;
      });
    }

    // Listen for PubSub Messages
    this.node.services.pubsub.addEventListener('message', async (evt: { detail: { topic: string; data: Uint8Array; from: any; }; }) => {
      await handlePubSubMessage(evt, this.node, this, this.algo, this.model, this.quoteMgr, this.topics, this.availableModels);
    });

    // Listen for Peer Discovery Events
    this.node.addEventListener('peer:discovery', async (e: { detail: { id: any; multiaddrs?: any[] }; }) => {
      const id = e.detail.id;
      logger.info('👋 Discovered Peer:', id.toString());
      
      // Store peer info for potential reconnection
      const multiaddrs = e.detail.multiaddrs?.map((ma: any) => ma.toString()) || [];
      this.knownPeers.set(id.toString(), {
        lastSeen: Date.now(),
        multiaddrs
      });
      
      try { 
        await this.node.dial(id); 
      } catch (err) {
        logger.error('❌ Failed to connect to peer:', err);
      }
    });

    // Listen for Connection Events
    this.node.addEventListener('peer:connect', (evt: any) => {
      const peerId = evt.detail.toString();
      logger.info(`💚 Connected to peer: ${peerId}`);
      
      // Reset reconnect attempts on successful connection
      this.reconnectAttempts.delete(peerId);
      
      // Update last seen time
      const peerInfo = this.knownPeers.get(peerId);
      if (peerInfo) {
        peerInfo.lastSeen = Date.now();
      } else {
        // Add to known peers if not already tracked
        this.knownPeers.set(peerId, {
          lastSeen: Date.now(),
          multiaddrs: []
        });
      }
    });

    // Listen for Disconnection Events with automatic reconnection
    this.node.addEventListener('peer:disconnect', async (evt: any) => {
      const peerId = evt.detail.toString();
      logger.info(`💔 Disconnected from peer: ${peerId}`);
      
      // Attempt to reconnect
      await scheduleReconnect(peerId, this.createReconnectionDependencies());
    });

    // Start periodic connection health check
    startConnectionHealthCheck(this.createReconnectionDependencies());
    
    logger.info('🚀 Diiisco Node fully initialized');
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
