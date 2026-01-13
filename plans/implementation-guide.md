# Implementation Guide: Direct Messaging & Relay Support

## Prerequisites

### Required Package Updates

Update [`package.json`](../package.json) dependencies:

```json
{
  "dependencies": {
    "@libp2p/autonat": "^2.0.0",
    "@libp2p/circuit-relay-v2": "^2.0.0", 
    "@libp2p/dcutr": "^2.0.0"
  }
}
```

## Step-by-Step Implementation

### Step 1: Environment Configuration

**File**: [`src/environment/environment.types.ts`](../src/environment/environment.types.ts)

Add new configuration interfaces:

```typescript
export interface RelayConfig {
  // Enable/disable relay server functionality
  enableRelayServer: boolean;
  
  // Auto-detect if node should be relay based on AutoNAT
  autoEnableRelay: boolean;
  
  // Maximum relayed connections to handle (if relay server)
  maxRelayedConnections: number;
  
  // Enable relay client (use relays to connect)
  enableRelayClient: boolean;
  
  // Enable DCUtR for connection upgrades
  enableDCUtR: boolean;
  
  // Maximum relayed data per connection (bytes)
  maxDataPerConnection: number;
  
  // Maximum duration for relayed connections (ms)
  maxRelayDuration: number;
}

export interface DirectMessagingConfig {
  // Enable direct messaging for post-quote-selection messages
  enabled: boolean;
  
  // Timeout for direct message attempts (ms)
  timeout: number;
  
  // Fallback to gossipsub on direct failure
  fallbackToGossipsub: boolean;
  
  // Custom protocol identifier
  protocol: string;
  
  // Maximum message size (bytes)
  maxMessageSize: number;
}

export interface Environment {
  // ... existing fields ...
  
  relay: RelayConfig;
  directMessaging: DirectMessagingConfig;
}
```

**File**: [`src/environment/example.environment.ts`](../src/environment/example.environment.ts)

Add default values:

```typescript
relay: {
  enableRelayServer: true,  // Will be auto-disabled if behind NAT
  autoEnableRelay: true,
  maxRelayedConnections: 100,
  enableRelayClient: true,
  enableDCUtR: true,
  maxDataPerConnection: 100 * 1024 * 1024, // 100 MB
  maxRelayDuration: 5 * 60 * 1000, // 5 minutes
},
directMessaging: {
  enabled: true,
  timeout: 10000, // 10 seconds
  fallbackToGossipsub: true,
  protocol: '/diiisco/direct/1.0.0',
  maxMessageSize: 10 * 1024 * 1024, // 10 MB
},
```

---

### Step 2: Update LibP2P Node Configuration

**File**: [`src/libp2p/node.ts`](../src/libp2p/node.ts)

Add required imports:

```typescript
import { autoNAT } from '@libp2p/autonat';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
```

Update the [`createLibp2pNode()`](../src/libp2p/node.ts:34) function:

```typescript
export const createLibp2pNode = async () => {
  const peer = await PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf');
  const env = environment;

  // Prepare Peer Discovery Modules
  const peerDiscovery: any[] = [mdns()];
  
  if (env.libp2pBootstrapServers && env.libp2pBootstrapServers.length > 0) {
    const parsedBootstrapServers = await lookupBootstrapServers();
    peerDiscovery.push(bootstrap({ list: parsedBootstrapServers }));
  }

  // Add circuit relay transport for NAT traversal
  const transports: any[] = [tcp()];
  if (env.relay.enableRelayClient) {
    transports.push(circuitRelayTransport());
  }

  // Prepare services object
  const services: any = {
    identify: identify(),
    identifyPush: identifyPush(),
    ping: ping({
      maxInboundStreams: 32,
      maxOutboundStreams: 32,
      timeout: 10000,
    }),
    pubsub: gossipsub({
      allowPublishToZeroTopicPeers: true,
      emitSelf: true,
      heartbeatInterval: 1000,
    }),
    dht: kadDHT(),
  };

  // Add AutoNAT service
  services.autoNAT = autoNAT();

  // Add DCUtR service if enabled
  if (env.relay.enableDCUtR) {
    services.dcutr = dcutr();
  }

  // Conditionally add relay server
  // (will be enabled/disabled based on AutoNAT detection)
  if (env.relay.enableRelayServer && env.relay.autoEnableRelay) {
    services.relay = circuitRelayServer({
      reservations: {
        maxReservations: env.relay.maxRelayedConnections * 2,
      },
      maxConnections: env.relay.maxRelayedConnections,
    });
  }

  const node = await createLibp2p({
    privateKey: peer.privateKey,
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${env.node?.port || 4242}`,
        // Add relay listen address
        ...(env.relay.enableRelayClient ? ['/p2p-circuit'] : []),
      ]
    },
    transports,
    connectionEncrypters: [noise()],
    peerDiscovery,
    streamMuxers: [yamux()],
    connectionManager: {
      minConnections: 2,
      maxConnections: 100,
      autoDialInterval: 10000,
      inboundConnectionThreshold: 20,
    } as any,
    services,
  });

  // Verify libp2p used the supplied Peer ID
  if (node.peerId.toString() !== peer.peerId.toString()) {
    throw new Error('libp2p did not use the supplied peerId');
  }
  
  await node.start();
  logger.info('✅ Node started with id:', node.peerId.toString());

  // Monitor AutoNAT events to adjust relay server status
  node.addEventListener('self:peer:update', (evt: any) => {
    const reachability = evt.detail.peer.metadata.get('autonat:reachability');
    logger.info(`🔍 AutoNAT Reachability: ${reachability}`);
    
    if (reachability === 'public' && env.relay.enableRelayServer) {
      logger.info('🌐 Node is publicly accessible - relay server is active');
    } else if (reachability === 'private') {
      logger.info('🔒 Node is behind NAT - using relay client mode only');
    }
  });

  // Show Connection Details
  logger.info('👂 Listening on:');
  node.getMultiaddrs().forEach(addr => logger.info(`   ${addr.toString()}`));
  if (env.node && env.node.url && !env.node.url.includes('localhost')) {
    logger.info(`📬 Other nodes can Connect at: "/dns4/${env.node.url}/tcp/${env.node?.port || 4242}/p2p/${node.peerId.toString()}"`);
  }

  startKeepAlive(node);

  return node;
};
```

---

### Step 3: Create Direct Messaging Handler

**New File**: `src/messaging/directMessaging.ts`

```typescript
import { logger } from '../utils/logger';
import { encode, decode } from 'msgpackr';
import { PubSubMessage } from '../types/messages';
import environment from '../environment/environment';
import { pipe } from 'it-pipe';
import all from 'it-all';
import { Stream } from '@libp2p/interface';

export class DirectMessagingHandler {
  private node: any;
  private protocol: string;
  private messageHandlers: Map<string, (msg: PubSubMessage, peerId: string) => Promise<void>>;

  constructor(node: any) {
    this.node = node;
    this.protocol = environment.directMessaging.protocol;
    this.messageHandlers = new Map();
  }

  /**
   * Register the direct messaging protocol handler
   */
  async registerProtocol() {
    await this.node.handle(this.protocol, async ({ stream, connection }: { stream: Stream, connection: any }) => {
      const peerId = connection.remotePeer.toString();
      logger.debug(`📨 Incoming direct message stream from ${peerId}`);
      
      try {
        await this.handleIncomingStream(stream, peerId);
      } catch (err: any) {
        logger.error(`❌ Error handling direct message stream: ${err.message}`);
        await stream.close();
      }
    });

    logger.info(`✅ Registered direct messaging protocol: ${this.protocol}`);
  }

  /**
   * Handle incoming direct message stream
   */
  private async handleIncomingStream(stream: Stream, peerId: string) {
    try {
      const data = await pipe(
        stream,
        async function* (source) {
          const chunks: Uint8Array[] = [];
          let totalSize = 0;
          const maxSize = environment.directMessaging.maxMessageSize;

          for await (const chunk of source) {
            totalSize += chunk.length;
            if (totalSize > maxSize) {
              throw new Error(`Message exceeds maximum size of ${maxSize} bytes`);
            }
            chunks.push(chunk);
          }

          // Combine all chunks
          const combined = new Uint8Array(totalSize);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }
          
          yield combined;
        },
        async (source) => await all(source)
      );

      if (data.length === 0) {
        logger.warn('⚠️ Received empty direct message');
        return;
      }

      // Decode message
      const message: PubSubMessage = decode(data[0]);
      logger.info(`📥 Received direct message: ${message.role} from ${peerId}`);

      // Dispatch to registered handler
      const handler = this.messageHandlers.get(message.role);
      if (handler) {
        await handler(message, peerId);
      } else {
        logger.warn(`⚠️ No handler registered for message role: ${message.role}`);
      }

      // Close the stream
      await stream.close();
    } catch (err: any) {
      logger.error(`❌ Error processing direct message: ${err.message}`);
      throw err;
    }
  }

  /**
   * Send a direct message to a specific peer
   * @returns true if sent successfully, false otherwise
   */
  async sendDirect(peerId: string, message: PubSubMessage): Promise<boolean> {
    const timeout = environment.directMessaging.timeout;
    
    try {
      logger.debug(`📤 Attempting to send direct message to ${peerId}: ${message.role}`);
      
      // Create stream with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const stream = await this.node.dialProtocol(peerId, this.protocol, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Encode and send message
      const encoded = encode(message);
      await pipe(
        [encoded],
        stream
      );

      logger.info(`✅ Direct message sent successfully to ${peerId}: ${message.role}`);
      return true;
    } catch (err: any) {
      logger.warn(`⚠️ Failed to send direct message to ${peerId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Register a handler for a specific message role
   */
  onMessage(role: string, handler: (msg: PubSubMessage, peerId: string) => Promise<void>) {
    this.messageHandlers.set(role, handler);
  }

  /**
   * Unregister handler for a message role
   */
  offMessage(role: string) {
    this.messageHandlers.delete(role);
  }
}
```

---

### Step 4: Create Message Router

**New File**: `src/messaging/messageRouter.ts`

```typescript
import { logger } from '../utils/logger';
import { PubSubMessage } from '../types/messages';
import { DirectMessagingHandler } from './directMessaging';
import { encode } from 'msgpackr';
import environment from '../environment/environment';

export enum DeliveryMethod {
  DIRECT = 'direct',
  RELAYED = 'relayed',
  GOSSIPSUB = 'gossipsub',
}

export interface DeliveryResult {
  method: DeliveryMethod;
  success: boolean;
  latency: number;
  error?: string;
}

export class MessageRouter {
  private node: any;
  private directMessaging: DirectMessagingHandler;
  private deliveryStats: Map<string, DeliveryResult[]>;

  // Messages that should use direct messaging after quote selection
  private readonly DIRECT_MESSAGE_TYPES = [
    'quote-accepted',
    'contract-created',
    'contract-signed',
    'inference-response',
  ];

  // Messages that should always use gossipsub (discovery phase)
  private readonly GOSSIPSUB_MESSAGE_TYPES = [
    'list-models',
    'list-models-response',
    'quote-request',
    'quote-response',
  ];

  constructor(node: any, directMessaging: DirectMessagingHandler) {
    this.node = node;
    this.directMessaging = directMessaging;
    this.deliveryStats = new Map();
  }

  /**
   * Send a message using the appropriate delivery method
   */
  async send(message: PubSubMessage, targetPeerId?: string): Promise<DeliveryResult> {
    const startTime = Date.now();

    // Determine if this message type should use direct messaging
    const shouldUseDirect = this.DIRECT_MESSAGE_TYPES.includes(message.role) &&
                           environment.directMessaging.enabled &&
                           targetPeerId;

    if (!shouldUseDirect) {
      // Use gossipsub for discovery messages or if direct is disabled
      return await this.sendViaGossipsub(message, startTime);
    }

    // Try direct messaging with fallback
    return await this.sendWithFallback(message, targetPeerId!, startTime);
  }

  /**
   * Send direct message with automatic fallback to gossipsub
   */
  private async sendWithFallback(
    message: PubSubMessage, 
    targetPeerId: string, 
    startTime: number
  ): Promise<DeliveryResult> {
    
    // Attempt 1: Direct connection
    try {
      const success = await this.sendViaDirect(targetPeerId, message);
      if (success) {
        const result: DeliveryResult = {
          method: DeliveryMethod.DIRECT,
          success: true,
          latency: Date.now() - startTime,
        };
        this.recordDelivery(targetPeerId, result);
        return result;
      }
    } catch (err: any) {
      logger.debug(`Direct messaging attempt failed: ${err.message}`);
    }

    // Attempt 2: Via relay (if connection is relayed)
    try {
      const connections = this.node.getConnections(targetPeerId);
      const hasRelayedConnection = connections.some((c: any) => 
        c.remoteAddr.toString().includes('/p2p-circuit/')
      );

      if (hasRelayedConnection) {
        const success = await this.sendViaDirect(targetPeerId, message);
        if (success) {
          const result: DeliveryResult = {
            method: DeliveryMethod.RELAYED,
            success: true,
            latency: Date.now() - startTime,
          };
          this.recordDelivery(targetPeerId, result);
          return result;
        }
      }
    } catch (err: any) {
      logger.debug(`Relayed messaging attempt failed: ${err.message}`);
    }

    // Attempt 3: Fallback to gossipsub
    if (environment.directMessaging.fallbackToGossipsub) {
      logger.info(`📡 Falling back to GossipSub for ${message.role} to ${targetPeerId}`);
      return await this.sendViaGossipsub(message, startTime);
    }

    // All attempts failed
    const result: DeliveryResult = {
      method: DeliveryMethod.DIRECT,
      success: false,
      latency: Date.now() - startTime,
      error: 'All delivery attempts failed',
    };
    this.recordDelivery(targetPeerId, result);
    return result;
  }

  /**
   * Send message via direct stream
   */
  private async sendViaDirect(peerId: string, message: PubSubMessage): Promise<boolean> {
    return await this.directMessaging.sendDirect(peerId, message);
  }

  /**
   * Send message via gossipsub
   */
  private async sendViaGossipsub(message: PubSubMessage, startTime: number): Promise<DeliveryResult> {
    try {
      const encoded = encode(message);
      await this.node.services.pubsub.publish('diiisco/models/1.0.0', encoded);
      
      logger.debug(`📡 Sent message via GossipSub: ${message.role}`);
      
      return {
        method: DeliveryMethod.GOSSIPSUB,
        success: true,
        latency: Date.now() - startTime,
      };
    } catch (err: any) {
      logger.error(`❌ Failed to send via GossipSub: ${err.message}`);
      return {
        method: DeliveryMethod.GOSSIPSUB,
        success: false,
        latency: Date.now() - startTime,
        error: err.message,
      };
    }
  }

  /**
   * Record delivery statistics
   */
  private recordDelivery(peerId: string, result: DeliveryResult) {
    if (!this.deliveryStats.has(peerId)) {
      this.deliveryStats.set(peerId, []);
    }
    
    const stats = this.deliveryStats.get(peerId)!;
    stats.push(result);
    
    // Keep only last 100 entries per peer
    if (stats.length > 100) {
      stats.shift();
    }
  }

  /**
   * Get delivery statistics for a peer
   */
  getStats(peerId: string): DeliveryResult[] {
    return this.deliveryStats.get(peerId) || [];
  }

  /**
   * Get aggregated statistics
   */
  getAggregatedStats() {
    let totalDirect = 0, successDirect = 0;
    let totalRelayed = 0, successRelayed = 0;
    let totalGossipsub = 0, successGossipsub = 0;
    let totalLatency = { direct: 0, relayed: 0, gossipsub: 0 };

    for (const stats of this.deliveryStats.values()) {
      for (const result of stats) {
        switch (result.method) {
          case DeliveryMethod.DIRECT:
            totalDirect++;
            if (result.success) {
              successDirect++;
              totalLatency.direct += result.latency;
            }
            break;
          case DeliveryMethod.RELAYED:
            totalRelayed++;
            if (result.success) {
              successRelayed++;
              totalLatency.relayed += result.latency;
            }
            break;
          case DeliveryMethod.GOSSIPSUB:
            totalGossipsub++;
            if (result.success) {
              successGossipsub++;
              totalLatency.gossipsub += result.latency;
            }
            break;
        }
      }
    }

    return {
      direct: {
        total: totalDirect,
        success: successDirect,
        successRate: totalDirect > 0 ? successDirect / totalDirect : 0,
        avgLatency: successDirect > 0 ? totalLatency.direct / successDirect : 0,
      },
      relayed: {
        total: totalRelayed,
        success: successRelayed,
        successRate: totalRelayed > 0 ? successRelayed / totalRelayed : 0,
        avgLatency: successRelayed > 0 ? totalLatency.relayed / successRelayed : 0,
      },
      gossipsub: {
        total: totalGossipsub,
        success: successGossipsub,
        successRate: totalGossipsub > 0 ? successGossipsub / totalGossipsub : 0,
        avgLatency: successGossipsub > 0 ? totalLatency.gossipsub / successGossipsub : 0,
      },
    };
  }
}
```

---

### Step 5: Update Message Handler

**File**: [`src/pubsub/handler.ts`](../src/pubsub/handler.ts)

Modify the function signature to accept `messageRouter`:

```typescript
import { MessageRouter } from '../messaging/messageRouter';

export const handlePubSubMessage = async (
  evt: any,
  node: any,
  nodeEvents: EventEmitter,
  algo: algorand,
  model: OpenAIInferenceModel,
  quoteMgr: quoteEngine,
  topics: string[],
  models: string[],
  messageRouter: MessageRouter, // Add this parameter
) => {
  // ... existing validation code ...

  // Replace all instances of:
  //   node.services.pubsub.publish('diiisco/models/1.0.0', encode(response));
  // With:
  //   await messageRouter.send(response, evt.detail.from.toString());

  // Example for quote-response:
  if (msg.role === 'quote-request' && models.includes(quoteRequestMsg.payload.model)) {
    // ... existing quote generation code ...
    
    response.signature = await algo.signObject(response);
    
    // Use messageRouter instead of direct pubsub publish
    await messageRouter.send(response, evt.detail.from.toString());
    
    logger.info(`📤 Sent quote-response to ${evt.detail.from.toString()}`);
  }

  // Similar changes for other message types:
  // - contract-created
  // - contract-signed  
  // - inference-response
  // - list-models-response
};
```

---

### Step 6: Update Main Application

**File**: [`src/index.ts`](../src/index.ts)

Add imports and initialize direct messaging:

```typescript
import { DirectMessagingHandler } from './messaging/directMessaging';
import { MessageRouter } from './messaging/messageRouter';

class Application extends EventEmitter {
  private node: any;
  private algo: algorand;
  private model: OpenAIInferenceModel;
  private availableModels: string[] = [];
  private quoteMgr: quoteEngine;
  private topics: string[] = [];
  private env: Environment;
  
  // Add these new properties
  private directMessaging!: DirectMessagingHandler;
  private messageRouter!: MessageRouter;
  
  // ... existing properties ...

  async start() {
    // ... existing bootstrap and node creation code ...

    this.node = await createLibp2pNode();
    await this.algo.initialize(this.node.peerId.toString());

    // Initialize direct messaging
    if (this.env.directMessaging.enabled) {
      this.directMessaging = new DirectMessagingHandler(this.node);
      await this.directMessaging.registerProtocol();
      
      this.messageRouter = new MessageRouter(this.node, this.directMessaging);
      logger.info('✅ Direct messaging initialized');
    } else {
      // Create a simple pass-through router if direct messaging is disabled
      this.messageRouter = new MessageRouter(this.node, this.directMessaging);
      logger.info('ℹ️ Direct messaging disabled, using gossipsub only');
    }

    // Register direct message handlers for post-selection messages
    if (this.env.directMessaging.enabled) {
      this.directMessaging.onMessage('quote-accepted', async (msg, peerId) => {
        await handleDirectMessage(msg, peerId, this.node, this, this.algo, this.model, this.quoteMgr, this.messageRouter);
      });
      
      this.directMessaging.onMessage('contract-created', async (msg, peerId) => {
        await handleDirectMessage(msg, peerId, this.node, this, this.algo, this.model, this.quoteMgr, this.messageRouter);
      });
      
      this.directMessaging.onMessage('contract-signed', async (msg, peerId) => {
        await handleDirectMessage(msg, peerId, this.node, this, this.algo, this.model, this.quoteMgr, this.messageRouter);
      });
      
      this.directMessaging.onMessage('inference-response', async (msg, peerId) => {
        await handleDirectMessage(msg, peerId, this.node, this, this.algo, this.model, this.quoteMgr, this.messageRouter);
      });
    }

    // ... rest of existing setup code ...

    // Listen for PubSub Messages (now with messageRouter)
    this.node.services.pubsub.addEventListener('message', async (evt: { detail: { topic: string; data: Uint8Array; from: any; }; }) => {
      await handlePubSubMessage(
        evt, 
        this.node, 
        this, 
        this.algo, 
        this.model, 
        this.quoteMgr, 
        this.topics, 
        this.availableModels,
        this.messageRouter // Pass messageRouter
      );
    });

    // Log messaging stats periodically
    if (this.env.directMessaging.enabled) {
      setInterval(() => {
        const stats = this.messageRouter.getAggregatedStats();
        logger.info(`📊 Messaging Stats:
          Direct: ${stats.direct.total} msgs (${(stats.direct.successRate * 100).toFixed(1)}% success, ${stats.direct.avgLatency.toFixed(0)}ms avg)
          Relayed: ${stats.relayed.total} msgs (${(stats.relayed.successRate * 100).toFixed(1)}% success, ${stats.relayed.avgLatency.toFixed(0)}ms avg)
          GossipSub: ${stats.gossipsub.total} msgs (${(stats.gossipsub.successRate * 100).toFixed(1)}% success, ${stats.gossipsub.avgLatency.toFixed(0)}ms avg)
        `);
      }, 60000); // Every minute
    }

    // ... rest of initialization ...
  }
}

// Helper function to process direct messages (similar to pubsub handler)
async function handleDirectMessage(
  msg: PubSubMessage,
  peerId: string,
  node: any,
  nodeEvents: EventEmitter,
  algo: algorand,
  model: OpenAIInferenceModel,
  quoteMgr: quoteEngine,
  messageRouter: MessageRouter,
) {
  // Reuse the same validation and processing logic from handlePubSubMessage
  // but extract it to handle both direct and gossipsub messages
  
  // Verify signature
  if (!msg.signature || !await algo.verifySignature(msg)) {
    logger.warn("❌ Direct message rejected due to invalid signature.");
    return;
  }
  
  logger.info("🔐 Signature of incoming direct message has been successfully verified.");
  
  // Process message based on role (same logic as in handlePubSubMessage)
  // ...
}
```

---

### Step 7: Add Tests

**New File**: `src/tests/directMessaging.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createLibp2pNode } from '../libp2p/node';
import { DirectMessagingHandler } from '../messaging/directMessaging';
import { MessageRouter } from '../messaging/messageRouter';

describe('Direct Messaging', () => {
  let node1: any, node2: any;
  let dm1: DirectMessagingHandler, dm2: DirectMessagingHandler;
  let router1: MessageRouter, router2: MessageRouter;

  beforeAll(async () => {
    // Create two nodes
    node1 = await createLibp2pNode();
    node2 = await createLibp2pNode();
    
    // Initialize direct messaging
    dm1 = new DirectMessagingHandler(node1);
    dm2 = new DirectMessagingHandler(node2);
    await dm1.registerProtocol();
    await dm2.registerProtocol();
    
    router1 = new MessageRouter(node1, dm1);
    router2 = new MessageRouter(node2, dm2);
    
    // Connect nodes
    await node1.dial(node2.getMultiaddrs()[0]);
  });

  afterAll(async () => {
    await node1.stop();
    await node2.stop();
  });

  it('should send and receive direct messages', async () => {
    const receivedMessages: any[] = [];
    
    dm2.onMessage('test-message', async (msg, peerId) => {
      receivedMessages.push({ msg, peerId });
    });

    const testMessage = {
      role: 'test-message',
      timestamp: Date.now(),
      id: 'test-123',
      fromWalletAddr: 'test-addr',
      payload: { data: 'Hello, World!' },
      signature: 'test-sig',
    };

    const result = await router1.send(testMessage, node2.peerId.toString());
    
    // Wait for message to be received
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].msg.payload.data).toBe('Hello, World!');
  });

  it('should fall back to gossipsub when direct fails', async () => {
    // Test with invalid peer ID
    const testMessage = {
      role: 'quote-accepted',
      timestamp: Date.now(),
      id: 'test-456',
      to: 'invalid-peer-id',
      fromWalletAddr: 'test-addr',
      payload: {},
      signature: 'test-sig',
    };

    const result = await router1.send(testMessage, 'invalid-peer-id');
    
    expect(result.method).toBe('gossipsub');
    expect(result.success).toBe(true);
  });
});
```

---

### Step 8: Documentation Updates

**File**: `README.md`

Add section on direct messaging:

```markdown
## Direct Messaging & Relay Configuration

DIIISCO nodes use a hybrid messaging approach:
- **Quote Discovery** uses GossipSub (broadcast) to find available providers
- **Post-Selection** uses direct peer-to-peer streams for faster, private communication

### Circuit Relay Support

Nodes behind NAT/firewalls can communicate via circuit relay:

```typescript
relay: {
  enableRelayServer: true,      // Act as relay for other nodes (auto-disabled if behind NAT)
  autoEnableRelay: true,         // Automatically detect and enable relay based on network
  maxRelayedConnections: 100,    // Limit concurrent relayed connections
  enableRelayClient: true,       // Use relays to connect when needed
  enableDCUtR: true,            // Enable direct connection upgrades
}
```

### Direct Messaging Configuration

```typescript
directMessaging: {
  enabled: true,                 // Enable direct messaging
  timeout: 10000,                // Timeout for direct message attempts (ms)
  fallbackToGossipsub: true,     // Fall back to GossipSub if direct fails
  protocol: '/diiisco/direct/1.0.0',
  maxMessageSize: 10485760,      // 10 MB max message size
}
```

### Network Topologies

#### Public Server (Open Ports)
- Acts as relay server for other nodes
- Receives direct connections
- Helps NAT traversal for client nodes

#### Behind NAT/Firewall
- Uses relay servers to communicate
- Attempts DCUtR for direct connection upgrades
- Falls back to GossipSub if needed

### Port Configuration

For relay server functionality, ensure port is accessible:

```bash
# Allow TCP port in firewall
sudo ufw allow 4242/tcp

# Or use custom port
export DIIISCO_PORT=5000
```

### Monitoring

View messaging statistics in logs:

```
📊 Messaging Stats:
  Direct: 45 msgs (95.6% success, 127ms avg)
  Relayed: 12 msgs (91.7% success, 342ms avg)
  GossipSub: 156 msgs (100.0% success, 89ms avg)
```
```

---

## Testing Checklist

Before deployment, verify:

- [ ] Direct messages work between public nodes
- [ ] Relay connections work for NAT nodes
- [ ] Fallback to gossipsub works when direct fails
- [ ] AutoNAT correctly detects network status
- [ ] DCUtR upgrades relayed connections
- [ ] Message signatures validate correctly
- [ ] Large messages (inference responses) transmit successfully
- [ ] Connection drops don't break quote flow
- [ ] Relay server respects connection limits
- [ ] Stats tracking works correctly

## Debugging Tips

### Enable Debug Logging

```typescript
// In logger configuration
logger.level = 'debug';
```

### Check Peer Connections

```typescript
// Get all connections
const connections = node.getConnections();

// Check if connection is relayed
connections.forEach(conn => {
  const isRelayed = conn.remoteAddr.toString().includes('/p2p-circuit/');
  console.log(`Peer ${conn.remotePeer}: ${isRelayed ? 'Relayed' : 'Direct'}`);
});
```

### Monitor AutoNAT Events

```typescript
node.addEventListener('self:peer:update', (evt) => {
  const reachability = evt.detail.peer.metadata.get('autonat:reachability');
  console.log(`AutoNAT status: ${reachability}`);
});
```

### Test Direct Messaging Manually

```typescript
// Send test direct message
const success = await directMessaging.sendDirect(peerId, testMessage);
console.log(`Direct send ${success ? 'succeeded' : 'failed'}`);
```

---

## Migration Path

### Phase 1: Deploy with Feature Flag OFF
- Deploy code to all nodes
- Set `directMessaging.enabled = false`
- Verify no regressions

### Phase 2: Enable on Test Network
- Enable direct messaging on test nodes
- Monitor for issues
- Validate performance improvements

### Phase 3: Gradual Production Rollout
- Enable on subset of production nodes
- Monitor metrics and errors
- Expand to all nodes

### Phase 4: Make Default
- Set `directMessaging.enabled = true` as default
- Update documentation
- Announce to node operators

---

## Performance Expectations

### Latency Improvements
- **Direct messaging**: 50-200ms typically
- **Relayed messaging**: 150-500ms typically  
- **GossipSub**: 100-1000ms typically

### Bandwidth Savings
- **Post-selection messages**: ~80% reduction (no broadcast overhead)
- **Large payloads** (inference responses): Most significant benefit

### Relay Server Requirements
- **CPU**: Minimal (mostly I/O bound)
- **Memory**: ~100-500MB depending on load
- **Bandwidth**: Depends on relayed traffic volume
- **Connections**: Scales with maxRelayedConnections setting
