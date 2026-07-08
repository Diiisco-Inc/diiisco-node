import { createLibp2pNode, lookupBootstrapServers } from './libp2p/node';
import { setLocalAddressProvider } from './libp2p/localAddresses';
import { ReconnectionDependencies, scheduleReconnect, attemptReconnect, reconnectToBootstrap, startConnectionHealthCheck, stopConnectionHealthCheck } from './libp2p/reconnection';
import { createApiServer } from './api/server';
import { EventEmitter } from 'events';
import algorand from "./utils/algorand";
import environment from "./environment/environment";
import { Environment } from "./environment/environment.types";
import { OpenAIInferenceModel } from "./utils/models";
import quoteEngine from "./utils/quoteEngine";
import OpenAI from "openai";
import { logger } from './utils/logger';
import { DirectMessagingHandler } from './messaging/directMessaging';
import { MessageRouter } from './messaging/messageRouter';
import { MessageProcessor } from './messaging/messageProcessor';
import { MeshReadinessMonitor } from './libp2p/meshReadinessMonitor';
import { MeshMessageQueue } from './messaging/meshMessageQueue';
import { decode } from 'msgpackr';
import { PubSubMessage } from './types/messages';
import { DEFAULT_DIRECT_MESSAGING_CONFIG } from './utils/defaults';
import type { Server } from 'http';

class Application extends EventEmitter {
  private node: any;
  private algo: algorand;
  private model: OpenAIInferenceModel;
  private availableModels: string[] = [];
  private quoteMgr: quoteEngine;
  private topics: string[] = [];
  private env: Environment;

  // Direct messaging components
  private directHandler: DirectMessagingHandler | null = null;
  private messageRouter: MessageRouter | null = null;
  private messageProcessor: MessageProcessor | null = null;

  private apiServer: Server | null = null;
  private isShuttingDown = false;
  
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

    // Expose our current multiaddrs to the message signer so every outgoing
    // message advertises how to reach us (incl. relay-circuit addresses).
    setLocalAddressProvider(() => this.node.getMultiaddrs().map((a: any) => a.toString()));

    // Initialize Algorand for DSCO Payments
    await this.algo.initialize(this.node.peerId.toString());

    // Load available models FIRST before initializing message processor
    if (this.env.models.enabled) {
      const models = await this.model.getModels();
      this.availableModels = models.filter((m: OpenAI.Models.Model) => m.object == 'model').map((modelInfo: OpenAI.Models.Model) => {
        logger.info(`🤖 Serving Model: ${modelInfo.id}`);
        return modelInfo.id;
      });
    }

    // Initialize direct messaging if enabled
    const directMessagingConfig = this.env.directMessaging || DEFAULT_DIRECT_MESSAGING_CONFIG;
    if (directMessagingConfig.enabled) {
      this.directHandler = new DirectMessagingHandler(
        this.node,
        async (msg, peerId) => {
          if (this.messageProcessor) {
            // Check if message is addressed to us
            if ('to' in msg && msg.to === this.node.peerId.toString()) {
              await this.messageProcessor.process(msg, peerId);
            } else if (!('to' in msg)) {
              // Messages without 'to' field (like list-models)
              await this.messageProcessor.process(msg, peerId);
            }
          }
        }
      );

      await this.directHandler.registerProtocol();
      logger.info('✅ Direct messaging enabled');
    }

    // Initialize message router
    this.messageRouter = new MessageRouter(this.node, this.directHandler);

    // Initialize unified message processor with loaded models
    this.messageProcessor = new MessageProcessor(
      this.algo,
      this.model,
      this.quoteMgr,
      this.availableModels,
      this,
      this.messageRouter,
      this.node.peerId.toString(),
      this.node
    );

    // Create a Relay PubSub Topic
    const topic = this.env.local?.privateTopic ?? 'diiisco/models/1.0.0';
    this.node.services.pubsub.subscribe(topic);
    this.topics.push(topic);

    // Event-driven mesh readiness — replaces per-request waitForMesh polling
    const meshMin = this.env.local?.enabled ? 0 : 1;
    const meshMonitor = new MeshReadinessMonitor(this.node, topic, meshMin);
    const meshQueue = new MeshMessageQueue(meshMonitor, this.messageRouter!);

    // Start the API Server
    if (this.env.api.enabled) {
      const { server } = createApiServer(this.node, this, this.algo, this.messageRouter!, meshQueue, this.model, this.availableModels);
      this.apiServer = server;
    }

    // Listen for PubSub Messages
    this.node.services.pubsub.addEventListener('message', async (evt: { detail: { topic: string; data: Uint8Array; from: any; }; }) => {
      if (this.topics.includes(evt.detail.topic) && this.messageProcessor) {
        const msg: PubSubMessage = decode(evt.detail.data);
        const sourcePeerId = evt.detail.from.toString();

        // Check if message is addressed to us (or is a broadcast message)
        if ('to' in msg && msg.to === this.node.peerId.toString()) {
          await this.messageProcessor.process(msg, sourcePeerId);
        } else if (!('to' in msg)) {
          // Messages without 'to' field (like quote-request, list-models)
          await this.messageProcessor.process(msg, sourcePeerId);
        }
      }
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

    // Start sleep detection via wall-clock polling
    this.startSleepDetection();

    logger.info('🚀 Diiisco Node fully initialized');

    // Signal PM2 that app is ready
    if (process.send) {
      process.send('ready');
    }
  }

  /**
   * Poll wall-clock time to detect host machine waking from sleep.
   * A gap larger than the poll interval indicates the process was suspended.
   */
  private startSleepDetection() {
    const POLL_INTERVAL = 2000;    // Poll every 2s
    const SLEEP_THRESHOLD = 10000; // Gap > 10s means the machine was asleep
    let lastCheck = Date.now();

    setInterval(() => {
      const now = Date.now();
      const gap = now - lastCheck;
      if (gap > SLEEP_THRESHOLD) {
        logger.info(`💤 Wake from sleep detected (gap: ${Math.round(gap / 1000)}s) — forcing reconnection`);
        this.handleWakeFromSleep();
      }
      lastCheck = now;
    }, POLL_INTERVAL);
  }

  /**
   * Close stale connections and force an immediate bootstrap reconnect after wake.
   */
  private async handleWakeFromSleep() {
    const connections = this.node.getConnections();
    logger.info(`🔌 Closing ${connections.length} potentially stale connection(s)...`);
    for (const conn of connections) {
      try { await conn.close(); } catch {}
    }

    // Reset exhausted reconnect attempt counters so cooldowns don't block recovery
    this.reconnectAttempts.clear();

    await reconnectToBootstrap(this.createReconnectionDependencies());
  }

  /**
   * Gracefully shutdown the application
   */
  async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      logger.info('Shutdown already in progress...');
      return;
    }
    this.isShuttingDown = true;

    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
      // 1. Stop accepting new API requests
      if (this.apiServer) {
        await new Promise<void>((resolve, reject) => {
          this.apiServer!.close((err) => {
            if (err) {
              logger.error('Error closing API server:', err);
              reject(err);
            } else {
              logger.info('API server closed');
              resolve();
            }
          });
        });
      }

      // 2. Stop background services (health checks)
      stopConnectionHealthCheck();

      // 3. Unsubscribe from pubsub topics
      for (const topic of this.topics) {
        try {
          this.node.services.pubsub.unsubscribe(topic);
          logger.info(`Unsubscribed from topic: ${topic}`);
        } catch (err) {
          logger.warn(`Error unsubscribing from ${topic}:`, err);
        }
      }

      // 4. Close libp2p node gracefully
      if (this.node) {
        await this.node.stop();
        logger.info('LibP2P node stopped');
      }

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  }
}

export { Application };
export { configureEnvironment } from './environment/environment';
export type { Environment } from './environment/environment.types';

const isMainModule = import.meta.url.replace('%20', ' ') === `file://${process.argv[1]}`
  || typeof process.env.pm_id !== 'undefined';

if (isMainModule) {
  const app = new Application();
  process.on('SIGTERM', () => app.shutdown('SIGTERM'));
  process.on('SIGINT', () => app.shutdown('SIGINT'));
  app.start().catch(err => {
    if (err.message === "PeerID not found.") {
      logger.error('🚨  Application failed to start: PeerID not found.');
    } else {
      logger.error('🚨  Application failed to start:', err);
    }
    process.exit(1);
  });
}
