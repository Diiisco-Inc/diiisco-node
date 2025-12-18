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
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';

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
  
  // Cache bootstrap servers for reconnection
  private bootstrapServers: string[] = [];

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
    
    // Cache bootstrap servers for reconnection fallback
    this.bootstrapServers = await lookupBootstrapServers();
    logger.info(`📋 Cached ${this.bootstrapServers.length} bootstrap server(s) for reconnection fallback`);
    
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
      
      // Store peer info for potential reconnection - convert multiaddrs to strings
      const multiaddrs = e.detail.multiaddrs?.map((ma: any) => {
        try {
          return ma.toString();
        } catch {
          return String(ma);
        }
      }) || [];
      
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
    this.node.addEventListener('peer:connect', async (evt: any) => {
      const peerId = evt.detail.toString();
      logger.info(`💚 Connected to peer: ${peerId}`);
      
      // Reset reconnect attempts on successful connection
      this.reconnectAttempts.delete(peerId);
      
      // Update last seen time and try to get current multiaddrs
      const peerInfo = this.knownPeers.get(peerId);
      if (peerInfo) {
        peerInfo.lastSeen = Date.now();
      }
      
      // Try to update multiaddrs from the active connection
      try {
        const connections = this.node.getConnections(evt.detail);
        if (connections.length > 0) {
          const addrs = connections.map((c: any) => c.remoteAddr?.toString()).filter(Boolean);
          if (addrs.length > 0) {
            const existing = this.knownPeers.get(peerId) || { lastSeen: Date.now(), multiaddrs: [] };
            // Merge new addresses with existing ones
            const allAddrs = [...new Set([...existing.multiaddrs, ...addrs])];
            this.knownPeers.set(peerId, {
              lastSeen: Date.now(),
              multiaddrs: allAddrs
            });
          }
        }
      } catch (err) {
        // Ignore errors when trying to get connection info
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
        
        // First, try using stored multiaddrs
        const peerInfo = this.knownPeers.get(peerId);
        
        if (peerInfo && peerInfo.multiaddrs.length > 0) {
          // Try each stored multiaddr
          for (const addrStr of peerInfo.multiaddrs) {
            try {
              const ma = multiaddr(addrStr);
              logger.debug(`🔄 Trying multiaddr: ${addrStr.slice(0, 50)}...`);
              await this.node.dial(ma);
              logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}... via stored multiaddr`);
              this.reconnectAttempts.delete(peerId);
              return;
            } catch (err) {
              // Try next address
              continue;
            }
          }
        }
        
        // Fallback: Try to dial by PeerId (libp2p may have cached addresses in peerStore)
        try {
          const peerIdObj = peerIdFromString(peerId);
          await this.node.dial(peerIdObj);
          logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}... via peerStore`);
          this.reconnectAttempts.delete(peerId);
          return;
        } catch (err: any) {
          logger.debug(`Could not dial by peerId: ${err.message}`);
        }
        
        // If we get here, all attempts failed
        throw new Error('All dial attempts failed');
        
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
   * Reconnect to bootstrap servers when we have zero connections
   */
  private async reconnectToBootstrap() {
    if (this.bootstrapServers.length === 0) {
      logger.warn('⚠️ No bootstrap servers configured for reconnection');
      return;
    }

    logger.info(`🔄 Attempting to reconnect to ${this.bootstrapServers.length} bootstrap server(s)...`);

    for (const addrStr of this.bootstrapServers) {
      try {
        const ma = multiaddr(addrStr);
        logger.info(`🔄 Dialing bootstrap: ${addrStr.slice(0, 60)}...`);
        await this.node.dial(ma);
        logger.info(`✅ Connected to bootstrap server`);
        // Successfully connected to at least one, that's enough to bootstrap
        return;
      } catch (err: any) {
        logger.debug(`❌ Failed to connect to bootstrap ${addrStr.slice(0, 40)}...: ${err.message}`);
      }
    }

    logger.warn('⚠️ Failed to connect to any bootstrap servers');
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
        
        // If we have ZERO connections, prioritize bootstrap servers
        if (uniquePeers.size === 0) {
          logger.warn('🚨 Zero connections! Reconnecting to bootstrap servers...');
          await this.reconnectToBootstrap();
          
          // Give it a moment to connect, then check again
          await new Promise(r => setTimeout(r, 5000));
          
          const newConnections = this.node.getConnections();
          if (newConnections.length > 0) {
            logger.info(`✅ Bootstrap reconnection successful: ${newConnections.length} connection(s)`);
            return; // Don't try known peers if bootstrap worked
          }
        }
        
        // Try to reconnect to known peers
        for (const [peerId, peerInfo] of this.knownPeers) {
          if (!uniquePeers.has(peerId)) {
            const timeSinceLastSeen = Date.now() - peerInfo.lastSeen;
            
            // Only try peers we've seen in the last hour
            if (timeSinceLastSeen < 3600000) {
              try {
                logger.info(`🔄 Trying to reconnect to known peer ${peerId.slice(0, 16)}...`);
                
                // Use stored multiaddrs if available
                if (peerInfo.multiaddrs.length > 0) {
                  for (const addrStr of peerInfo.multiaddrs) {
                    try {
                      const ma = multiaddr(addrStr);
                      await this.node.dial(ma);
                      logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
                      break;
                    } catch {
                      continue;
                    }
                  }
                } else {
                  // Fallback to peerId
                  const peerIdObj = peerIdFromString(peerId);
                  await this.node.dial(peerIdObj);
                }
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
