import { isPeerId, KEEP_ALIVE, type PeerId } from '@libp2p/interface';
import { logger } from '../utils/logger';
import { isPeerDenied } from './networkGuard';
import { toDialTarget, type DialingNode } from './dialTarget';

// Track health check interval for cleanup
let healthCheckIntervalId: ReturnType<typeof setInterval> | null = null;

/** Peers with a retry timer already running, so a second disconnect event does not start a second chain. */
const pendingReconnects = new Set<string>();

/** Longest wait between redials of one peer. Retries slow down to this and then keep going. */
export const MAX_RECONNECT_DELAY = 5 * 60 * 1000;
/** A peer not seen for this long is forgotten (and no longer redialled). */
export const KNOWN_PEER_WINDOW = 24 * 60 * 60 * 1000;
/** Connections the node tries to hold; below this it redials known peers and goes looking for more. */
export const DEFAULT_TARGET_CONNECTIONS = 8;
/** Redials started per maintenance pass, so a mass drop is not a mass dial. */
export const DEFAULT_MAX_DIALS_PER_PASS = 5;
/** How often, while below target, the node walks the DHT for new peers. */
export const DEFAULT_DISCOVERY_INTERVAL = 5 * 60 * 1000;
/** Redials started by a manual reconnect, which is allowed more than a routine pass. */
export const FORCE_MAX_DIALS_PER_PASS = 25;
/** Addresses remembered per peer. */
const MAX_STORED_ADDRESSES = 6;
/** Tag that makes libp2p's own reconnect queue redial the peer too. */
export const KEEP_ALIVE_TAG = `${KEEP_ALIVE}-diiisco`;

/**
 * Stop the connection health check interval
 */
export function stopConnectionHealthCheck(): void {
  if (healthCheckIntervalId) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
    logger.info('📊 Connection health monitor stopped');
  }
}

export interface ReconnectionDependencies {
  reconnectAttempts: Map<string, { count: number; lastAttempt: number }>;
  RECONNECT_COOLDOWN: number;
  RECONNECT_DELAY: number;
  attemptReconnect: (peerId: string) => Promise<void>;
  node: DialingNode;
  knownPeers: Map<string, { lastSeen: number; multiaddrs: string[] }>;
  MIN_CONNECTIONS: number;
  /** Connections to aim for; defaults to {@link DEFAULT_TARGET_CONNECTIONS}. */
  TARGET_CONNECTIONS?: number;
  MAX_DIALS_PER_PASS?: number;
  DISCOVERY_INTERVAL?: number;
  BOOTSTRAP_RETRY_INTERVAL: number;
  lastBootstrapAttempt: number;
  /** When the DHT was last walked for new peers. */
  lastDiscovery?: number;
  bootstrapAddresses: string[];
  lastConnectionCount: number;
}

/** Wait before redial number `count` (0-based): the base delay, doubling, capped at {@link MAX_RECONNECT_DELAY}. */
export function reconnectDelay(count: number, base: number): number {
  return Math.min(base * Math.pow(2, count), MAX_RECONNECT_DELAY);
}

/**
 * `addr` with `/p2p/<id>` on the end, so a dial checks it reached the peer it
 * meant to. Peer-store addresses usually lack it.
 */
export function withPeerId(addr: string, peerId: string): string {
  return addr.endsWith(`/p2p/${peerId}`) ? addr : `${addr}/p2p/${peerId}`;
}

/**
 * Schedule a redial of a peer that dropped. Retries back off from the base
 * delay to {@link MAX_RECONNECT_DELAY} and then continue at that pace for as
 * long as the peer is within {@link KNOWN_PEER_WINDOW}: giving up after a few
 * tries meant a peer that was down for a few minutes was never seen again.
 */
export async function scheduleReconnect(peerId: string, deps: ReconnectionDependencies) {
  // A peer on another network is never redialled
  if (isPeerDenied(peerId)) {
    deps.knownPeers.delete(peerId);
    deps.reconnectAttempts.delete(peerId);
    pendingReconnects.delete(peerId);
    return;
  }

  if (pendingReconnects.has(peerId)) return;

  const known = deps.knownPeers.get(peerId);
  if (known && Date.now() - known.lastSeen > KNOWN_PEER_WINDOW) {
    deps.knownPeers.delete(peerId);
    deps.reconnectAttempts.delete(peerId);
    return;
  }

  const currentInfo = deps.reconnectAttempts.get(peerId) || { count: 0, lastAttempt: 0 };
  const delay = reconnectDelay(currentInfo.count, deps.RECONNECT_DELAY);

  logger.info(`🔄 Scheduling reconnect attempt ${currentInfo.count + 1} for ${peerId.slice(0, 16)}... in ${Math.round(delay / 1000)}s`);

  deps.reconnectAttempts.set(peerId, { count: currentInfo.count + 1, lastAttempt: Date.now() });
  pendingReconnects.add(peerId);

  const timer = setTimeout(async () => {
    pendingReconnects.delete(peerId);
    try {
      await deps.attemptReconnect(peerId);
    } catch (err: any) {
      // A timer callback must not reject: an unhandled rejection stops the node.
      logger.warn(`⚠️ Reconnect to ${peerId.slice(0, 16)}... failed unexpectedly: ${err?.message ?? err}`);
    }
  }, delay);
  timer.unref?.();
}

/**
 * Dial a peer through its stored addresses, then by peer id. Resolves once one
 * dial works; throws the last error otherwise.
 */
async function redialPeer(deps: ReconnectionDependencies, peerId: string): Promise<void> {
  const stored = deps.knownPeers.get(peerId)?.multiaddrs ?? [];

  for (const addr of stored) {
    const target = toDialTarget(withPeerId(addr, peerId));
    if (!target) continue;
    try {
      await deps.node.dial(target);
      return;
    } catch (err: any) {
      logger.debug(`Dial to stored address ${addr.slice(0, 60)} failed: ${err?.message ?? err}`);
    }
  }

  // Fall back to dialing by peer ID, which uses whatever the peer store holds
  const peerTarget = toDialTarget(peerId);
  if (!peerTarget) throw new Error('not a valid peer id');
  await deps.node.dial(peerTarget);
}

const isConnectedTo = (deps: ReconnectionDependencies, peerId: string): boolean =>
  deps.node.getConnections().some((conn) => conn.remotePeer.toString() === peerId);

/**
 * Attempt to reconnect to a specific peer; on failure, schedule the next try.
 */
export async function attemptReconnect(peerId: string, deps: ReconnectionDependencies) {
  if (isConnectedTo(deps, peerId)) {
    logger.info(`✅ Already reconnected to ${peerId.slice(0, 16)}...`);
    deps.reconnectAttempts.delete(peerId);
    return;
  }

  try {
    logger.info(`🔄 Attempting reconnect to ${peerId.slice(0, 16)}...`);
    await redialPeer(deps, peerId);
    logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
    deps.reconnectAttempts.delete(peerId);
  } catch (err: any) {
    logger.warn(`❌ Reconnect failed for ${peerId.slice(0, 16)}...: ${err?.message ?? err}`);
    await scheduleReconnect(peerId, deps);
  }
}

/**
 * Remember how to reach a peer we are connected to: the addresses libp2p holds
 * for it, direct ones first (a relayed address stops working when the relay
 * does), each with the peer id on the end. Best effort; never throws.
 */
export async function rememberPeerAddresses(
  node: DialingNode,
  knownPeers: ReconnectionDependencies['knownPeers'],
  peerId: PeerId,
): Promise<void> {
  try {
    const peer = await node.peerStore?.get(peerId);
    if (!peer) return;
    const id = peerId.toString();
    const all: string[] = (peer.addresses ?? []).map((a: any) => withPeerId(a.multiaddr.toString(), id));
    const direct = all.filter((a) => !a.includes('/p2p-circuit'));
    const relayed = all.filter((a) => a.includes('/p2p-circuit'));
    const multiaddrs = [...new Set([...direct, ...relayed])].slice(0, MAX_STORED_ADDRESSES);
    if (multiaddrs.length === 0) return;

    const entry = knownPeers.get(id);
    if (entry) entry.multiaddrs = multiaddrs;
    else knownPeers.set(id, { lastSeen: Date.now(), multiaddrs });
  } catch (err: any) {
    logger.debug(`Could not read addresses for ${peerId.toString().slice(0, 16)}...: ${err?.message ?? err}`);
  }
}

/** Tag (or untag) a peer so libp2p's own reconnect queue redials it after a drop. Best effort; never throws. */
export async function setKeepAlive(node: DialingNode, peerId: PeerId, keep: boolean): Promise<void> {
  try {
    await node.peerStore?.merge(peerId, { tags: { [KEEP_ALIVE_TAG]: keep ? { value: 1 } : undefined } });
  } catch (err: any) {
    logger.debug(`Could not ${keep ? 'tag' : 'untag'} ${peerId.toString().slice(0, 16)}...: ${err?.message ?? err}`);
  }
}

/**
 * Attempt to reconnect to bootstrap servers
 */
export async function reconnectToBootstrap(deps: ReconnectionDependencies, settleMs = 5000): Promise<number> {
  if (deps.bootstrapAddresses.length === 0) {
    return 0;
  }

  logger.info(`🔄 Attempting to reconnect to ${deps.bootstrapAddresses.length} bootstrap server(s)...`);
  
  let successCount = 0;
  
  for (const addr of deps.bootstrapAddresses) {
    const target = toDialTarget(addr);
    if (!target) continue;
    try {
      logger.info(`🔄 Dialing bootstrap: ${addr.slice(0, 60)}...`);
      await deps.node.dial(target);
      logger.info(`✅ Connected to bootstrap server`);
      successCount++;
    } catch (err: any) {
      logger.warn(`❌ Failed to connect to bootstrap ${addr.slice(0, 40)}...: ${err.message}`);
    }
  }
  
  if (successCount === 0) {
    logger.warn(`⚠️ Failed to connect to any bootstrap servers`);
  } else {
    // Wait a moment for connections to stabilize
    await new Promise(resolve => setTimeout(resolve, settleMs));
    
    const connections = deps.node.getConnections();
    const uniquePeers = new Set(connections.map((c) => c.remotePeer.toString()));
    logger.info(`✅ Bootstrap reconnection successful: ${uniquePeers.size} connection(s)`);
  }
  
  return successCount;
}

/** Bootstrap addresses whose peer is not currently connected. Addresses without a peer id are always included. */
function missingBootstrapAddresses(deps: ReconnectionDependencies, connected: Set<string>): string[] {
  return deps.bootstrapAddresses.filter((addr) => {
    const id = /\/p2p\/([^/]+)/.exec(addr)?.[1];
    return id === undefined || !connected.has(id);
  });
}

/**
 * Walk the DHT towards our own id for peers we are not yet connected to, and
 * dial a few. Discovery events come from mDNS and a one-shot bootstrap, so
 * without this a node that lost its peers is never told about new ones.
 * Best effort; never throws.
 */
export async function discoverMorePeers(deps: ReconnectionDependencies, connected: Set<string>, limit: number, now: number = Date.now()): Promise<number> {
  const routing = deps.node.peerRouting;
  const self = deps.node.peerId;
  if (!routing || !self) return 0;

  let dialled = 0;
  try {
    const signal = AbortSignal.timeout(15000);
    for await (const info of routing.getClosestPeers(self.toMultihash().bytes, { signal })) {
      if (dialled >= limit) break;
      const id = info.id.toString();
      if (id === self.toString() || connected.has(id) || isPeerDenied(id)) continue;

      const multiaddrs = info.multiaddrs.map((a: any) => withPeerId(a.toString(), id));
      const known = deps.knownPeers.get(id);
      if (known) known.multiaddrs = multiaddrs.length > 0 ? multiaddrs : known.multiaddrs;
      else deps.knownPeers.set(id, { lastSeen: now, multiaddrs });

      try {
        await redialPeer(deps, id);
        dialled++;
        logger.info(`🧭 Connected to newly discovered peer ${id.slice(0, 16)}...`);
      } catch (err: any) {
        logger.debug(`Could not dial discovered peer ${id.slice(0, 16)}...: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    logger.debug(`DHT walk ended: ${err?.message ?? err}`);
  }
  return dialled;
}

/**
 * One pass of connection upkeep:
 *  - log the connection count when it changes;
 *  - below `MIN_CONNECTIONS`, redial the bootstrap servers;
 *  - redial any missing bootstrap server, whatever the count;
 *  - below `TARGET_CONNECTIONS`, redial known peers that are due (backed off, a
 *    few at a time) and, now and then, walk the DHT for new ones;
 *  - forget peers not seen for a day.
 *
 * `force` is for a manual reconnect (`diiisco peers --reconnect`): it ignores
 * the target, the backoff and the retry timers, redials every known peer that
 * is not connected (up to {@link FORCE_MAX_DIALS_PER_PASS}), redials missing
 * bootstrap servers and walks the DHT, all right now.
 *
 * Redialling known peers used to happen only below `MIN_CONNECTIONS`, which
 * three bootstrap connections always satisfied, so every other peer that
 * dropped stayed gone.
 */
export async function runMaintenancePass(
  deps: ReconnectionDependencies,
  now: number = Date.now(),
  options: { force?: boolean } = {},
): Promise<void> {
  const force = options.force === true;
  const target = force ? Infinity : (deps.TARGET_CONNECTIONS ?? DEFAULT_TARGET_CONNECTIONS);
  const maxDials = force ? FORCE_MAX_DIALS_PER_PASS : (deps.MAX_DIALS_PER_PASS ?? DEFAULT_MAX_DIALS_PER_PASS);
  const discoveryInterval = deps.DISCOVERY_INTERVAL ?? DEFAULT_DISCOVERY_INTERVAL;

  const uniquePeers = new Set(deps.node.getConnections().map((c) => c.remotePeer.toString()));
  const connectionCount = uniquePeers.size;

  // Only log if connection count changed
  if (connectionCount !== deps.lastConnectionCount) {
    logger.info(`📊 Connection health: ${connectionCount} unique peer(s) connected`);
    deps.lastConnectionCount = connectionCount;
  }

  let bootstrapTried = false;
  if (connectionCount < deps.MIN_CONNECTIONS) {
    logger.warn(`⚠️ Below minimum connections (${deps.MIN_CONNECTIONS}). Attempting to discover more peers...`);

    if (connectionCount === 0) {
      logger.warn(`🚨 Zero connections! Reconnecting to bootstrap servers...`);
      await reconnectToBootstrap(deps);
      deps.lastBootstrapAttempt = now;
      bootstrapTried = true;
    } else if ((now - deps.lastBootstrapAttempt) > deps.BOOTSTRAP_RETRY_INTERVAL) {
      logger.info(`🔄 Attempting to connect to additional bootstrap servers...`);
      await reconnectToBootstrap(deps);
      deps.lastBootstrapAttempt = now;
      bootstrapTried = true;
    }
  }

  // A bootstrap server that dropped is worth redialling even when others are up.
  if (!bootstrapTried && (force || (now - deps.lastBootstrapAttempt) > deps.BOOTSTRAP_RETRY_INTERVAL)) {
    const missing = missingBootstrapAddresses(deps, uniquePeers);
    if (missing.length > 0) {
      logger.info(`🔄 ${missing.length} bootstrap server(s) not connected — redialling...`);
      await reconnectToBootstrap({ ...deps, bootstrapAddresses: missing }, 0);
      deps.lastBootstrapAttempt = now;
    }
  }

  if (connectionCount < target) {
    const due = [...deps.knownPeers.entries()]
      .filter(([peerId, info]) => {
        if (uniquePeers.has(peerId) || isPeerDenied(peerId)) return false;
        if (now - info.lastSeen > KNOWN_PEER_WINDOW) return false;
        if (force) return true;
        if (pendingReconnects.has(peerId)) return false;
        const attempt = deps.reconnectAttempts.get(peerId);
        return !attempt || now - attempt.lastAttempt >= reconnectDelay(attempt.count, deps.RECONNECT_DELAY);
      })
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .slice(0, maxDials);

    await Promise.allSettled(due.map(async ([peerId]) => {
      logger.info(`🔄 Trying to reconnect to known peer ${peerId.slice(0, 16)}...`);
      try {
        await redialPeer(deps, peerId);
        logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
        deps.reconnectAttempts.delete(peerId);
      } catch (err: any) {
        const current = deps.reconnectAttempts.get(peerId) || { count: 0, lastAttempt: 0 };
        deps.reconnectAttempts.set(peerId, { count: current.count + 1, lastAttempt: now });
        logger.warn(`⚠️ Could not reconnect to known peer ${peerId.slice(0, 16)}...: ${err?.message ?? err}`);
      }
    }));

    if (force || (now - (deps.lastDiscovery ?? 0)) >= discoveryInterval) {
      deps.lastDiscovery = now;
      await discoverMorePeers(deps, uniquePeers, maxDials, now);
    }
  }

  // Forget peers not seen for a day, and the retry state of peers already forgotten.
  for (const [peerId, peerInfo] of deps.knownPeers) {
    if (now - peerInfo.lastSeen > KNOWN_PEER_WINDOW) {
      deps.knownPeers.delete(peerId);
      deps.reconnectAttempts.delete(peerId);
      const id = toDialTarget(peerId);
      if (isPeerId(id)) void setKeepAlive(deps.node, id, false);
    }
  }
  for (const peerId of deps.reconnectAttempts.keys()) {
    if (!deps.knownPeers.has(peerId) && !pendingReconnects.has(peerId)) deps.reconnectAttempts.delete(peerId);
  }
}

/**
 * Periodic upkeep of the node's connections (see {@link runMaintenancePass}).
 */
export function startConnectionHealthCheck(deps: ReconnectionDependencies) {
  const CHECK_INTERVAL = 60000; // Check every 60 seconds

  // Stop any existing health check before starting a new one
  stopConnectionHealthCheck();

  let running = false;
  healthCheckIntervalId = setInterval(async () => {
    // A pass can outlast the interval (dials time out at 10 s); never overlap.
    if (running) return;
    running = true;
    try {
      await runMaintenancePass(deps);
    } catch (err: any) {
      logger.warn(`⚠️ Connection maintenance failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  }, CHECK_INTERVAL);

  logger.info('📊 Connection health monitor started (interval: 60s)');
}

// ---------------------------------------------------------------------------
// Sleep / wake
// ---------------------------------------------------------------------------

/** How often the wall clock is sampled, and the jump that means the machine was asleep. */
export const SLEEP_POLL_INTERVAL_MS = 2000;
export const SLEEP_GAP_THRESHOLD_MS = 10000;

export interface SleepDetectorOptions {
  pollMs?: number;
  /** A gap between samples longer than this means the process was suspended. */
  thresholdMs?: number;
  now?: () => number;
}

/**
 * Detect the host waking from sleep by watching the wall clock: a timer that
 * should fire every `pollMs` and instead fires after minutes was suspended in
 * between. Returns a function that stops the detector.
 *
 * The timer is unref'd and clearable. It used to be neither, so it outlived a
 * shutdown.
 */
export function startSleepDetector(onWake: (gapMs: number) => void, options: SleepDetectorOptions = {}): () => void {
  const pollMs = options.pollMs ?? SLEEP_POLL_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? SLEEP_GAP_THRESHOLD_MS;
  const now = options.now ?? Date.now;
  let lastCheck = now();

  const timer = setInterval(() => {
    const current = now();
    const gap = current - lastCheck;
    lastCheck = current;
    if (gap > thresholdMs) onWake(gap);
  }, pollMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

/** Backoff between recovery attempts after a wake: the network is often not up for the first few seconds. */
export const WAKE_RECOVERY_DELAYS_MS = [0, 2000, 5000, 10000, 30000, 60000];

export interface WakeRecoveryOptions {
  delaysMs?: number[];
  /** Wait for the connections to settle after a successful bootstrap dial. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isShuttingDown?: () => boolean;
  /** When set, also wait for the node to see subscribers on this GossipSub topic. */
  meshTopic?: string;
  meshWaitMs?: number;
}

export interface WakeRecoveryResult {
  /** Connected to at least one peer (or there was nothing to connect to). */
  connected: boolean;
  /** `true` when no mesh topic was asked about. */
  meshReady: boolean;
  attempts: number;
}

/**
 * Get back on the network after a wake.
 *
 * One bootstrap dial is not enough: the radio is routinely still coming up when
 * the clock jumps, so the first attempt fails and the node used to sit idle
 * until the next 60s health check. This retries on a backoff until a connection
 * exists, then makes sure the mesh topic has subscribers again, re-announcing
 * the subscription once if it does not.
 */
export async function recoverAfterWake(deps: ReconnectionDependencies, options: WakeRecoveryOptions = {}): Promise<WakeRecoveryResult> {
  const delays = options.delaysMs ?? WAKE_RECOVERY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isShuttingDown = options.isShuttingDown ?? (() => false);
  const connectionCount = () => new Set<string>(deps.node.getConnections().map((c: any) => c.remotePeer.toString())).size;

  // A private network has no bootstrap servers; peers there are found by mDNS,
  // and there is nothing to dial.
  if (deps.bootstrapAddresses.length === 0) return { connected: true, meshReady: true, attempts: 0 };

  let attempts = 0;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    if (isShuttingDown()) return { connected: false, meshReady: false, attempts };
    attempts += 1;

    await reconnectToBootstrap(deps, options.settleMs);
    if (connectionCount() > 0) break;
    logger.warn(`⚠️ Still offline after waking (attempt ${attempts}) — the network may not be up yet.`);
  }

  if (connectionCount() === 0) return { connected: false, meshReady: false, attempts };
  if (!options.meshTopic) return { connected: true, meshReady: true, attempts };

  const meshReady = await waitForMesh(deps, options.meshTopic, options.meshWaitMs ?? 15000, sleep);
  return { connected: true, meshReady, attempts };
}

/** Wait for subscribers on `topic`; if none appear, announce our subscription again and wait once more. */
async function waitForMesh(deps: ReconnectionDependencies, topic: string, waitMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const pubsub = deps.node.services?.pubsub;
  if (!pubsub) return true;
  const subscribers = () => pubsub.getSubscribers(topic).length;
  const pollMs = 1000;

  const waitOnce = async (): Promise<boolean> => {
    for (let waited = 0; waited < waitMs; waited += pollMs) {
      if (subscribers() > 0) return true;
      await sleep(pollMs);
    }
    return subscribers() > 0;
  };

  if (await waitOnce()) return true;

  logger.warn('⚠️ No mesh subscribers after waking — re-announcing our subscription.');
  try {
    pubsub.unsubscribe(topic);
    pubsub.subscribe(topic);
  } catch (err: any) {
    logger.warn(`⚠️ Could not re-subscribe to the mesh topic: ${err.message}`);
    return false;
  }
  return waitOnce();
}
