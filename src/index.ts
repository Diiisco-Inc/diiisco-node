import { createLibp2pNode, lookupBootstrapServers } from './libp2p/node';
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
  private lastConnectionCount = -1;
  private lastBootstrapAttempt = 0;
  private readonly BOOTSTRAP_RETRY_INTERVAL = 120000; // Retry bootstrap every 2 minutes when disconnected

  constructor() {
    super();
    this.env = environment;
    this.algo = new algorand();
    this.model = new OpenAIInferenceModel(`${this.env.models.baseURL}:${this.env.models.port}/v1`);
    this.quoteMgr = new quoteEngine(this);
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
      await this.scheduleReconnect(peerId);
    });

    // Start periodic connection health check
    this.startConnectionHealthCheck();
    
    logger.info('🚀 Diiisco Node fully initialized');
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private async scheduleReconnect(peerId: string) {
    const attemptInfo = this.reconnectAttempts.get(peerId);
    const now = Date.now();
    
    // Check if we should reset attempts (cooldown expired)
    if (attemptInfo && (now - attemptInfo.lastAttempt) > this.RECONNECT_COOLDOWN) {
      this.reconnectAttempts.delete(peerId);
    }
    
    const currentInfo = this.reconnectAttempts.get(peerId) || { count: 0, lastAttempt: 0 };
    
    if (currentInfo.count >= this.MAX_RECONNECT_ATTEMPTS) {
      // Don't log every time - just silently skip until cooldown
      return;
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, 80s
    const delay = this.RECONNECT_DELAY * Math.pow(2, currentInfo.count);
    
    logger.info(`🔄 Scheduling reconnect attempt ${currentInfo.count + 1}/${this.MAX_RECONNECT_ATTEMPTS} for ${peerId.slice(0, 16)}... in ${delay/1000}s`);
    
    this.reconnectAttempts.set(peerId, { count: currentInfo.count + 1, lastAttempt: now });

    setTimeout(async () => {
      await this.attemptReconnect(peerId);
    }, delay);
  }

  /**
   * Attempt to reconnect to a specific peer
   */
  private async attemptReconnect(peerId: string) {
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
      
      // Try to get stored multiaddrs for this peer
      const peerInfo = this.knownPeers.get(peerId);
      
      if (peerInfo && peerInfo.multiaddrs.length > 0) {
        // Try each multiaddr
        for (const addr of peerInfo.multiaddrs) {
          try {
            await this.node.dial(addr);
            logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}... via stored multiaddr`);
            this.reconnectAttempts.delete(peerId);
            return;
          } catch (err) {
            // Try next address
          }
        }
      }
      
      // Fall back to dialing by peer ID
      await this.node.dial(peerId);
      logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
      this.reconnectAttempts.delete(peerId);
      
    } catch (err: any) {
      logger.warn(`❌ Reconnect failed for ${peerId.slice(0, 16)}...: ${err.message}`);
      
      // Schedule another attempt
      await this.scheduleReconnect(peerId);
    }
  }

  /**
   * Attempt to reconnect to bootstrap servers
   */
  private async reconnectToBootstrap(): Promise<number> {
    if (this.bootstrapAddresses.length === 0) {
      return 0;
    }

    logger.info(`🔄 Attempting to reconnect to ${this.bootstrapAddresses.length} bootstrap server(s)...`);
    
    let successCount = 0;
    
    for (const addr of this.bootstrapAddresses) {
      try {
        logger.info(`🔄 Dialing bootstrap: ${addr.slice(0, 60)}...`);
        await this.node.dial(addr);
        logger.info(`✅ Connected to bootstrap server`);
        successCount++;
      } catch (err: any) {
        // Log at debug level to reduce spam
        logger.debug(`❌ Failed to connect to bootstrap ${addr.slice(0, 40)}...: ${err.message}`);
      }
    }
    
    if (successCount === 0) {
      logger.warn(`⚠️ Failed to connect to any bootstrap servers`);
    } else {
      // Wait a moment for connections to stabilize
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const connections = this.node.getConnections();
      const uniquePeers = new Set(connections.map((c: any) => c.remotePeer.toString()));
      logger.info(`✅ Bootstrap reconnection successful: ${uniquePeers.size} connection(s)`);
    }
    
    return successCount;
  }

  /**
   * Periodic check to ensure we maintain minimum connections
   */
  private startConnectionHealthCheck() {
    const CHECK_INTERVAL = 60000; // Check every 60 seconds

    setInterval(async () => {
      const connections = this.node.getConnections();
      const uniquePeers = new Set(connections.map((c: any) => c.remotePeer.toString()));
      const connectionCount = uniquePeers.size;
      const now = Date.now();
      
      // Only log if connection count changed
      if (connectionCount !== this.lastConnectionCount) {
        logger.info(`📊 Connection health: ${connectionCount} unique peer(s) connected`);
        this.lastConnectionCount = connectionCount;
      }

      if (connectionCount < this.MIN_CONNECTIONS) {
        // Only warn if this is a new problem
        if (connectionCount !== this.lastConnectionCount || connectionCount === 0) {
          logger.warn(`⚠️ Below minimum connections (${this.MIN_CONNECTIONS}). Attempting to discover more peers...`);
        }
        
        // If we have zero connections, immediately try bootstrap
        if (connectionCount === 0) {
          logger.warn(`🚨 Zero connections! Reconnecting to bootstrap servers...`);
          await this.reconnectToBootstrap();
          this.lastBootstrapAttempt = now;
        } 
        // If below minimum but > 0, try bootstrap periodically
        else if ((now - this.lastBootstrapAttempt) > this.BOOTSTRAP_RETRY_INTERVAL) {
          logger.info(`🔄 Attempting to connect to additional bootstrap servers...`);
          await this.reconnectToBootstrap();
          this.lastBootstrapAttempt = now;
        }
        
        // Also try reconnecting to known peers
        for (const [peerId, peerInfo] of this.knownPeers) {
          if (!uniquePeers.has(peerId)) {
            const timeSinceLastSeen = now - peerInfo.lastSeen;
            const attemptInfo = this.reconnectAttempts.get(peerId);
            
            // Only try peers we've seen recently and haven't exhausted attempts on
            if (timeSinceLastSeen < 3600000) { // 1 hour
              // Check if attempts have cooled down
              if (attemptInfo && attemptInfo.count >= this.MAX_RECONNECT_ATTEMPTS) {
                if ((now - attemptInfo.lastAttempt) > this.RECONNECT_COOLDOWN) {
                  // Reset attempts after cooldown
                  this.reconnectAttempts.delete(peerId);
                } else {
                  continue; // Skip this peer, still in cooldown
                }
              }
              
              try {
                logger.info(`🔄 Trying to reconnect to known peer ${peerId.slice(0, 16)}...`);
                
                if (peerInfo.multiaddrs.length > 0) {
                  for (const addr of peerInfo.multiaddrs) {
                    try {
                      await this.node.dial(addr);
                      logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
                      break;
                    } catch {
                      // Try next address
                    }
                  }
                } else {
                  await this.node.dial(peerId);
                }
              } catch (err) {
                // Track failed attempt
                const current = this.reconnectAttempts.get(peerId) || { count: 0, lastAttempt: 0 };
                this.reconnectAttempts.set(peerId, { count: current.count + 1, lastAttempt: now });
              }
            }
          }
        }
      }

      // Clean up old known peers (older than 24 hours)
      const ONE_DAY = 24 * 60 * 60 * 1000;
      for (const [peerId, peerInfo] of this.knownPeers) {
        if (now - peerInfo.lastSeen > ONE_DAY) {
          this.knownPeers.delete(peerId);
          this.reconnectAttempts.delete(peerId);
        }
      }

      // Also clean up old reconnect attempts that have cooled down
      for (const [peerId, attemptInfo] of this.reconnectAttempts) {
        if ((now - attemptInfo.lastAttempt) > this.RECONNECT_COOLDOWN * 2) {
          this.reconnectAttempts.delete(peerId);
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
