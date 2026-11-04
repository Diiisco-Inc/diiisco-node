import { createLibp2p } from 'libp2p';
import { bunSafeTcp } from './bunSafeTcp';
import { noise, pureJsCrypto } from '@chainsafe/libp2p-noise';
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
import environment from '../environment/runtime';
import { PUBLIC_BOOTSTRAP_SERVERS } from '../environment/defaults';
import { nfdToNodeAddress } from '../utils/algorand';
import { getNetworkId, PUBLIC_NETWORK_ID } from '../utils/topic';
import { NetworkGuard, bootstrapPeerIds } from './networkGuard';
import { relayLimits } from './relayLimits';
import { describeClose } from './connectionLog';

// Maximum circuit-relay reservations a public relay node will accept from
// NAT'd peers. Only relevant when this node runs the relay server.
const MAX_RELAY_RESERVATIONS = 200;

export const lookupBootstrapServers = async (): Promise<string[]> => {
  // A private/local network never talks to the public bootstrap servers, but
  // keeps any the operator added for their own network.
  // Arrays are replaced, not merged, by configureEnvironment, so an override
  // with `libp2pBootstrapServers: []` (or every entry commented out) would
  // otherwise wipe the defaults: unset or empty means "the public servers"
  // on the public network.
  const isLocal = environment.local?.enabled === true;
  const requested = environment.libp2pBootstrapServers?.length
    ? environment.libp2pBootstrapServers
    : (isLocal ? [] : PUBLIC_BOOTSTRAP_SERVERS);
  const configured = requested.filter(
    (addr: string) => !isLocal || !PUBLIC_BOOTSTRAP_SERVERS.includes(addr.trim()),
  );

  // No Bootstrap Servers Configured
  if (configured.length === 0) {
    return [];
  }

  // Process Bootstrap Servers
    const parsedBootstrapServers = (await Promise.all(configured.map(async (addr: string) => {
      addr = addr.trim();
      if (addr?.endsWith('diiisco.algo')) {
        const nfdAddress = await nfdToNodeAddress(addr);
        return nfdAddress;
      }
      return addr;
    }))).filter((addr: string | null) => addr !== null);
  return parsedBootstrapServers;
};

/**
 * The announced public URL of this node, or null when it has none (localhost
 * and 127.0.0.1 don't count). A node with a public URL runs the circuit-relay
 * server and is a "relay" on the status pages; without one it connects out
 * through relays.
 */
export const getPublicUrl = (): string | null => {
  return environment.node?.url && !environment.node.url.includes('localhost') && environment.node.url !== '127.0.0.1'
    ? environment.node.url
    : null;
};

export const isPublicNode = (): boolean => getPublicUrl() !== null;

export const createLibp2pNode = async () => {
  // Load or Create a Peer ID
  const peer = await PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf');

  // Resolve bootstrap servers once — reused for both peer discovery and for
  // building explicit circuit-relay listen addresses.
  const parsedBootstrapServers = await lookupBootstrapServers();

  // Prepare Peer Discovery Modules
  // A node in local mode uses its own mDNS service tag so it neither queries
  // for nor answers to the public network's (and vice versa).
  const networkId = getNetworkId();
  const peerDiscovery: any[] = [
    mdns(networkId === PUBLIC_NETWORK_ID ? {} : { serviceTag: `_diiisco-${networkId}._udp.local` }),
  ];

  if (parsedBootstrapServers.length > 0) {
    peerDiscovery.push(bootstrap({
      list: parsedBootstrapServers,
    }));
  }

  //Detect if Public Node
  const port = environment.node?.port || 4242;
  const publicUrl = getPublicUrl();
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

  // Refuses connections to peers on another network. An operator's own
  // bootstrap/relay servers are exempt: they may predate the network marker.
  const guard = new NetworkGuard(networkId, bootstrapPeerIds(parsedBootstrapServers));

  // Create the Libp2p Node with connection management and keep-alive
  const node = await createLibp2p({
    privateKey: peer.privateKey,
    connectionGater: guard.gater(),
    addresses: {
      listen: [
        // Every node listens on TCP. mDNS can only advertise addresses we
        // listen on, so a private node without one is invisible to (and cannot
        // be dialed by) peers on the same LAN, even with no bootstrap set.
        `/ip4/0.0.0.0/tcp/${port}`,
        // Required for circuitRelayTransport to call reserveRelay() and make
        // relay reservations. Without this entry pendingReservations stays empty
        // and every discovered relay peer is immediately rejected.
        ...(isPublicNode ? [] : [...relayListenAddrs, '/p2p-circuit']),
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
      // Not `tcp()`: under Bun an aborted dial hands its AbortSignal to
      // net.connect(), which destroys the socket with a DOMException after
      // libp2p has removed the 'error' listener — killing the process. See
      // src/libp2p/bunSafeTcp.ts.
      bunSafeTcp(),
      ...(isPublicNode ? [] : [circuitRelayTransport()]), // Only add circuit relay transport if not a public node
    ],
    // `pureJsCrypto`, not the default: @chainsafe/libp2p-noise routes
    // ChaCha20-Poly1305 payloads >= 1200 bytes to node:crypto's
    // createCipheriv('chacha20-poly1305'), which Bun does not implement
    // ("Unknown cipher: chacha20-poly1305") — and our shipped binaries are
    // built with `bun build --compile`. Small payloads take the package's WASM
    // path, so the handshake, identify and ping all succeed and only real
    // prompts and completions fail, mid-stream, as a dropped connection.
    // The same gap exists in Electron; upstream guards that case but keys the
    // guard on `isElectronMain`, which is false in a renderer or utility
    // process. Pinning the pure-JS backend covers every runtime we ship on.
    connectionEncrypters: [noise({ crypto: pureJsCrypto })],
    peerDiscovery,
    streamMuxers: [yamux()],
    
    // libp2p pings every connection and aborts one whose ping fails. The
    // default timeout adapts down to 5 s, so a busy moment (pure-JS noise
    // crypto, GC, a laptop waking) could abort many connections at once; give a
    // ping 20-60 s. This is the only keep-alive: the app used to run a second
    // ping loop that closed connections on a single failed ping.
    connectionMonitor: {
      pingInterval: 15000,
      pingTimeout: { minTimeout: 20000, maxTimeout: 60000 },
      abortConnectionOnPingFailure: true,
    },

    // Connection Manager. (`minConnections` and `autoDialInterval` used to be
    // set here; libp2p 3.x has neither, so they did nothing — keeping the
    // connection count up is `src/libp2p/reconnection.ts`'s job.)
    connectionManager: {
      // Maximum number of connections allowed
      maxConnections: 100,
      // Inbound connections per host per window before new ones are refused
      inboundConnectionThreshold: 20,
      // Peers tagged keep-alive (see `setKeepAlive`) are redialled by libp2p
      // itself after a drop: this many tries, the first after this many ms.
      reconnectRetries: 5,
      reconnectRetryInterval: 2000,
    },

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

      // Same DHT protocol only within one network: a private cluster must not
      // walk (or be walked by) the public DHT.
      dht: kadDHT(networkId === PUBLIC_NETWORK_ID ? {} : { protocol: `/diiisco/${networkId}/kad/1.0.0` }),

      // AutoNAT for detecting reachability
      autoNAT: autoNAT(),

      // Circuit Relay Server — only public nodes accept reservations
      ...(isPublicNode ? {
        relay: circuitRelayServer({
          reservations: {
            maxReservations: MAX_RELAY_RESERVATIONS,
            // A relayed connection is cut when it reaches either limit, taking
            // GossipSub and any request in flight with it. They were 10 minutes
            // and 25 MB, which dropped every relayed peer 10 minutes after it
            // connected; see `relayLimits.ts` and `node.relay` in the config.
            // libp2p's own default (128 KB / 2 min) truncates real completions,
            // and an unlimited relay invites abuse, so there is still a bound.
            defaultDurationLimit: relayLimits(environment.node?.relay).durationLimitMs,
            defaultDataLimit: relayLimits(environment.node?.relay).dataLimitBytes,
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
  await guard.attach(node);

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

  // Say when a relayed connection closes and how long it lasted: a connection
  // closing at the relay's duration limit is the relay cutting it, not the peer.
  node.addEventListener('connection:close', (evt: any) => {
    try {
      const { relayed, message } = describeClose(evt.detail);
      if (relayed) logger.info(message);
      else logger.debug(message);
    } catch {
      // Logging must never throw out of an event listener.
    }
  });

  return node;
};

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
