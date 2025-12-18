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
  private availableModels: string[] = [];
  private quoteMgr: quoteEngine;
  private topics: string[] = [];
  private env: Environment; // Explicitly type the environment
  
  // Track important peers for reconnection
  private knownPeers: Map<string, { lastSeen: number; multiaddrs: string[] }> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds between reconnect attempts

  constructor() {
    super();
    this.env = environment; // Assign the imported environment
    this.algo = new algorand();
    this.model = new OpenAIInferenceModel(`${this.env.models.baseURL}:${this.env.models.port}/v1`);
    this.quoteMgr = new quoteEngine(this);
  }

  async start() {
    
    // Create and Start the Libp2p Node
    this.node = await createLibp2pNode();
    
    // Initialize Algorand for DSCO Payments
    await this.algo.initialize(this.node.peerId.toString());

    //Create a Relay PubSub Topic
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
    this.node.services.pubsub.addEventListener('message', async (evt: { detail: { topic: string; data: Uint8Array; from: any; }; }) => { // TODO: Define a proper type for evt
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
      }
    });

    // Listen for Disconnection Events with automatic reconnection
    this.node.addEventListener('peer:disconnect', async (evt: any) => {
      const peerId = evt.detail.toString();
      logger.info(`💔 Disconnected from peer: ${peerId}`);
      
      // Attempt to reconnect to important peers
      await this.attemptReconnect(peerId);
    });

    // Start periodic connection health check
    this.startConnectionHealthCheck();
    
    logger.info('🚀 Diiisco Node fully initialized');
  }

  /**
   * Attempt to reconnect to a disconnected peer
   */
  private async attemptReconnect(peerId: string) {
    const attempts = this.reconnectAttempts.get(peerId) || 0;
    
    if (attempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logger.warn(`⚠️ Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached for peer ${peerId.slice(0, 16)}...`);
      this.reconnectAttempts.delete(peerId);
      return;
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, 80s
    const delay = this.RECONNECT_DELAY * Math.pow(2, attempts);
    
    logger.info(`🔄 Scheduling reconnect attempt ${attempts + 1}/${this.MAX_RECONNECT_ATTEMPTS} for ${peerId.slice(0, 16)}... in ${delay/1000}s`);
    
    this.reconnectAttempts.set(peerId, attempts + 1);

    setTimeout(async () => {
      // Check if already connected
      const connections = this.node.getConnections();
      const isConnected = connections.some((conn: any) => conn.remotePeer.toString() === peerId);
      
      if (isConnected) {
        logger.info(`✅ Already reconnected to ${peerId.slice(0, 16)}...`);
        this.reconnectAttempts.delete(peerId);
        return;
      }

      try {
        logger.info(`🔄 Attempting reconnect to ${peerId.slice(0, 16)}...`);
        
        // Try to dial the peer by ID (libp2p may have cached addresses)
        await this.node.dial(peerId);
        
        logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
        this.reconnectAttempts.delete(peerId);
      } catch (err: any) {
        logger.warn(`❌ Reconnect failed for ${peerId.slice(0, 16)}...: ${err.message}`);
        
        // Schedule another attempt if we haven't hit the max
        const currentAttempts = this.reconnectAttempts.get(peerId) || 0;
        if (currentAttempts < this.MAX_RECONNECT_ATTEMPTS) {
          await this.attemptReconnect(peerId);
        }
      }
    }, delay);
  }

  /**
   * Periodic check to ensure we maintain minimum connections
   */
  private startConnectionHealthCheck() {
    const CHECK_INTERVAL = 60000; // Check every 60 seconds
    const MIN_CONNECTIONS = 2;

    setInterval(async () => {
      const connections = this.node.getConnections();
      const uniquePeers = new Set(connections.map((c: any) => c.remotePeer.toString()));
      
      logger.info(`📊 Connection health: ${uniquePeers.size} unique peer(s) connected`);

      if (uniquePeers.size < MIN_CONNECTIONS) {
        logger.warn(`⚠️ Below minimum connections (${MIN_CONNECTIONS}). Attempting to discover more peers...`);
        
        // Try to reconnect to known peers
        for (const [peerId, peerInfo] of this.knownPeers) {
          if (!uniquePeers.has(peerId)) {
            const timeSinceLastSeen = Date.now() - peerInfo.lastSeen;
            
            // Only try peers we've seen in the last hour
            if (timeSinceLastSeen < 3600000) {
              try {
                logger.info(`🔄 Trying to reconnect to known peer ${peerId.slice(0, 16)}...`);
                await this.node.dial(peerId);
              } catch (err) {
                // Silently fail, will try again next interval
              }
            }
          }
        }
      }

      // Clean up old known peers (older than 24 hours)
      const ONE_DAY = 24 * 60 * 60 * 1000;
      for (const [peerId, peerInfo] of this.knownPeers) {
        if (Date.now() - peerInfo.lastSeen > ONE_DAY) {
          this.knownPeers.delete(peerId);
        }
      }

    }, CHECK_INTERVAL);

    logger.info('📊 Connection health monitor started (interval: 60s)');
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
