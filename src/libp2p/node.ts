import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { identify, identifyPush } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { mdns } from '@libp2p/mdns';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@libp2p/gossipsub';
import { kadDHT } from '@libp2p/kad-dht';
import { autoNAT } from '@libp2p/autonat';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { isPrivate } from '@libp2p/utils';
import { FaultTolerance } from '@libp2p/interface';
import { logger } from '../utils/logger';
import { PeerIdManager } from './peerIdManager';
import { bootstrap } from '@libp2p/bootstrap';
import environment from '../environment/environment';
import { nfdToNodeAddress } from '../utils/algorand';

// Maximum circuit-relay reservations a public relay node will accept from
// NAT'd peers. Only relevant when this node runs the relay server.
const MAX_RELAY_RESERVATIONS = 200;

export const lookupBootstrapServers = async (): Promise<string[]> => {
  // No Bootstrap Servers Configured
  if (!environment.libp2pBootstrapServers || environment.libp2pBootstrapServers.length === 0) {
    return [];
  }

  // Process Bootstrap Servers
    const parsedBootstrapServers = (await Promise.all(environment.libp2pBootstrapServers.map(async (addr: string) => {
      addr = addr.trim();
      if (addr?.endsWith('diiisco.algo')) {
        const nfdAddress = await nfdToNodeAddress(addr);
        return nfdAddress;
      }
      return addr;
    }))).filter((addr: string | null) => addr !== null);
  return parsedBootstrapServers;
};

export const createLibp2pNode = async () => {
  // Load or Create a Peer ID
  const peer = await PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf');

  // Resolve bootstrap servers once — reused for both peer discovery and for
  // building explicit circuit-relay listen addresses.
  const parsedBootstrapServers = await lookupBootstrapServers();

  // Prepare Peer Discovery Modules
  const peerDiscovery: any[] = [mdns()];

  if (parsedBootstrapServers.length > 0) {
    peerDiscovery.push(bootstrap({
      list: parsedBootstrapServers,
    }));
  }

  //Detect if Public Node
  const port = environment.node?.port || 4242;
  const publicUrl = environment.node?.url && !environment.node.url.includes('localhost') && environment.node.url !== '127.0.0.1'
  ? environment.node.url
  : null;
  const isPublicNode = publicUrl !== null;

  // For private nodes, listen on an explicit circuit address per bootstrap
  // relay (e.g. /dns4/relay/tcp/4242/p2p/<relayId>/p2p-circuit). This forces a
  // reservation on each known relay ('configured' path) instead of relying on
  // auto-discovery, which is what leaves NAT'd nodes with zero relay addresses.
  // A bare '/p2p-circuit' is also kept so additional relays can be discovered.
  const relayListenAddrs = parsedBootstrapServers
    .filter((addr) => addr.includes('/p2p/'))
    .map((addr) => `${addr}/p2p-circuit`);

  // Surface which relays we'll try to reserve on — makes it obvious in the logs
  // whether a private node has a usable relay to fall back on.
  if (!isPublicNode) {
    if (relayListenAddrs.length > 0) {
      logger.info(`🛰️  Requesting relay reservations on ${relayListenAddrs.length} relay(s):`);
      relayListenAddrs.forEach((addr) => logger.info(`   ${addr}`));
    } else {
      logger.warn('⚠️ No bootstrap relays with a /p2p/ peer id — cannot reserve a relay, only bare /p2p-circuit discovery will be attempted');
    }
  }

  // Create the Libp2p Node with connection management and keep-alive
  const node = await createLibp2p({
    privateKey: peer.privateKey,
    addresses: {
      listen: [
        // Required for circuitRelayTransport to call reserveRelay() and make
        // relay reservations. Without this entry pendingReservations stays empty
        // and every discovered relay peer is immediately rejected.
        ...(isPublicNode ? [`/ip4/0.0.0.0/tcp/${port}`] : [...relayListenAddrs, '/p2p-circuit']),
      ],
      // Announce the stable DNS name so relay circuit addresses returned to
      // clients carry the domain rather than a raw IP.
      ...(publicUrl ? { announce: [`/dns4/${publicUrl}/tcp/${port}`] } : {}),
    },
    // Private nodes listen on explicit relay-circuit addresses that may fail if
    // a relay is momentarily unreachable at startup — tolerate that and run
    // dial-only, letting relay discovery retry. Public nodes keep fatal
    // behaviour so a failed TCP bind surfaces loudly.
    transportManager: {
      faultTolerance: isPublicNode ? FaultTolerance.FATAL_ALL : FaultTolerance.NO_FATAL,
    },
    transports: [
      tcp(),
      ...(isPublicNode ? [] : [circuitRelayTransport()]), // Only add circuit relay transport if not a public node
    ],
    connectionEncrypters: [noise()],
    peerDiscovery,
    streamMuxers: [yamux()],
    
    // Connection Manager - prevents aggressive connection pruning
    connectionManager: {
      // Minimum number of connections to maintain
      minConnections: 2,
      // Maximum number of connections allowed
      maxConnections: 100,
      // Auto-dial interval to maintain connections (ms)
      autoDialInterval: 10000,
      // Inbound connection threshold before pruning
      inboundConnectionThreshold: 20,
    } as any,
    
    services: {
      identify: identify(),
      identifyPush: identifyPush(),

      // Ping service for keep-alive (using standard libp2p protocol)
      ping: ping({
        maxInboundStreams: 32,
        maxOutboundStreams: 32,
        timeout: 10000, // 10 second timeout for pings
      }),

      // GossipSub with optimized settings
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: true,
        // Heartbeat interval - how often to check peer health (ms)
        heartbeatInterval: 1000,
        // Number of heartbeats without response before peer is considered dead
        // mcacheLength: 6,
        // mcacheGossip: 3,
        // Time to wait for responses (ms)
        // seenTTL: 120000,
      }),

      dht: kadDHT(),

      // AutoNAT for detecting reachability
      autoNAT: autoNAT(),

      // Circuit Relay Server — only public nodes accept reservations
      ...(isPublicNode ? {
        relay: circuitRelayServer({
          reservations: {
            maxReservations: MAX_RELAY_RESERVATIONS,
            // Bound relayed connections to the OpenAI API envelope rather than
            // libp2p's tiny 128KB / 2-min default (which truncates real
            // completions) or an unlimited relay (which invites abuse):
            //  - 10 min: the OpenAI SDK default request timeout.
            //  - 25 MB: OpenAI's documented max content size (26,214,400 bytes),
            //    ample for any completion while capping relay abuse.
            // DCUtR still upgrades heavy traffic to a direct connection off the relay.
            defaultDurationLimit: 10 * 60 * 1000,
            defaultDataLimit: BigInt(25 * 1024 * 1024),
          },
        })
      } : {}),

      // DCUtR — upgrade relayed connections to direct when possible
      dcutr: dcutr(),
    }
  });

  // Check if Libp2p used the supplied Peer ID
  if (node.peerId.toString() !== peer.peerId.toString()) {
    throw new Error('libp2p did not use the supplied peerId');
  }
  
  // Start the Libp2p Node
  await node.start()
  logger.info('✅ Node started with id:', node.peerId.toString());

  // Log relay role so it's immediately clear on startup
  if (isPublicNode) {
    logger.info('🛰️  Circuit relay server: ENABLED (will accept reservations from private nodes)');
  } else {
    logger.info('🔗 Circuit relay client: ENABLED (will seek relay reservations behind NAT)');
  }

  // Show Connection Details
  logger.info('👂 Listening on:');
  node.getMultiaddrs().forEach(addr => logger.info(`   ${addr.toString()}`));
  if (environment.node && environment.node.url && !environment.node.url.includes('localhost')) {
    logger.info(`📬 Other nodes can Connect at: "/dns4/${environment.node.url}/tcp/${environment.node?.port || 4242}/p2p/${node.peerId.toString()}"`);
  }

  // In libp2p v3, AutoNAT works by confirming/removing observed addresses rather than
  // setting a reachability metadata key. We infer reachability by filtering getMultiaddrs().
  node.addEventListener('self:peer:update', () => {
    const publicAddrs = node.getMultiaddrs().filter((a: any) => !isPrivate(a) && !a.toString().includes('p2p-circuit'));
    if (publicAddrs.length > 0 && isPublicNode) {
      logger.info(`🌐 Node is publicly reachable: ${publicAddrs.map((a: any) => a.toString()).join(', ')}`);
    }
  });

  // Start keep-alive ping loop for connected peers
  startKeepAlive(node);

  return node;
};

/**
 * Periodically ping connected peers to keep connections alive
 * This prevents NAT timeouts and detects dead peers early
 */
async function startKeepAlive(node: any) {
  const PING_INTERVAL = 30000; // Ping every 30 seconds
  const PING_TIMEOUT = 10000;  // 10 second timeout per ping

  setInterval(async () => {
    const connections = node.getConnections();
    
    if (connections.length === 0) {
      logger.debug('🔄 Keep-alive: No connections to ping');
      return;
    }

    logger.debug(`🔄 Keep-alive: Pinging ${connections.length} peer(s)...`);

    for (const conn of connections) {
      const peerId = conn.remotePeer;
      
      try {
        const latency = await node.services.ping.ping(peerId, {
          signal: AbortSignal.timeout(PING_TIMEOUT)
        });
        logger.debug(`📶 Ping to ${peerId.toString().slice(0, 16)}...: ${latency}ms`);
      } catch (err: any) {
        logger.warn(`⚠️ Keep-alive ping failed for ${peerId.toString().slice(0, 16)}... — closing dead connection`);
        try { await conn.close(); } catch {}
      }
    }
  }, PING_INTERVAL);

  logger.info('🔄 Keep-alive ping service started (interval: 30s)');
}

export async function waitForMesh(node: any, topic: string, { min = 1, timeoutMs = 10000 } = {}) {
  const start = Date.now()
  for (;;) {
    const subs = node.services.pubsub.getSubscribers(topic)
    if (subs.length >= min) return subs
    if (Date.now() - start > timeoutMs) {
      logger.error(`Timeout waiting for peers in topic "${topic}"`);
      throw new Error(`No peers in topic "${topic}"`);
    }
    await new Promise(r => setTimeout(r, 300))
  }
}
