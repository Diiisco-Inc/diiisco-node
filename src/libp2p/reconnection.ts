import { logger } from '../utils/logger';

// Track health check interval for cleanup
let healthCheckIntervalId: ReturnType<typeof setInterval> | null = null;

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
  MAX_RECONNECT_ATTEMPTS: number;
  RECONNECT_DELAY: number;
  attemptReconnect: (peerId: string) => Promise<void>;
  node: any; // Assuming node is needed by other functions
  knownPeers: Map<string, { lastSeen: number; multiaddrs: string[] }>;
  MIN_CONNECTIONS: number;
  BOOTSTRAP_RETRY_INTERVAL: number;
  lastBootstrapAttempt: number;
  bootstrapAddresses: string[];
  lastConnectionCount: number;
  // Add any other dependencies here
}

export async function scheduleReconnect(peerId: string, deps: ReconnectionDependencies) {
  const attemptInfo = deps.reconnectAttempts.get(peerId);
  const now = Date.now();

  // Check if we should reset attempts (cooldown expired)
  if (attemptInfo && (now - attemptInfo.lastAttempt) > deps.RECONNECT_COOLDOWN) {
    deps.reconnectAttempts.delete(peerId);
  }

  const currentInfo = deps.reconnectAttempts.get(peerId) || { count: 0, lastAttempt: 0 };

  if (currentInfo.count >= deps.MAX_RECONNECT_ATTEMPTS) {
    // Don't log every time - just silently skip until cooldown
    return;
  }

  // Exponential backoff: 5s, 10s, 20s, 40s, 80s
  const delay = deps.RECONNECT_DELAY * Math.pow(2, currentInfo.count);

  logger.info(`🔄 Scheduling reconnect attempt ${currentInfo.count + 1}/${deps.MAX_RECONNECT_ATTEMPTS} for ${peerId.slice(0, 16)}... in ${delay/1000}s`);

  deps.reconnectAttempts.set(peerId, { count: currentInfo.count + 1, lastAttempt: now });

  setTimeout(async () => {
    await deps.attemptReconnect(peerId);
  }, delay);
}

/**
 * Attempt to reconnect to a specific peer
 */
export async function attemptReconnect(peerId: string, deps: ReconnectionDependencies) {
  // Check if already connected
  const connections = deps.node.getConnections();
  const isConnected = connections.some((conn: any) => conn.remotePeer.toString() === peerId);

  if (isConnected) {
    logger.info(`✅ Already reconnected to ${peerId.slice(0, 16)}...`);
    deps.reconnectAttempts.delete(peerId);
    return;
  }

  try {
    logger.info(`🔄 Attempting reconnect to ${peerId.slice(0, 16)}...`);

    // Try to get stored multiaddrs for this peer
    const peerInfo = deps.knownPeers.get(peerId);

    if (peerInfo && peerInfo.multiaddrs.length > 0) {
      // Try each multiaddr
      for (const addr of peerInfo.multiaddrs) {
        try {
          await deps.node.dial(addr);
          logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}... via stored multiaddr`);
          deps.reconnectAttempts.delete(peerId);
          return;
        } catch (err) {
          // Try next address
        }
      }
    }

    // Fall back to dialing by peer ID
    await deps.node.dial(peerId);
    logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
    deps.reconnectAttempts.delete(peerId);

  } catch (err: any) {
    logger.warn(`❌ Reconnect failed for ${peerId.slice(0, 16)}...: ${err.message}`);

    // Schedule another attempt
    await scheduleReconnect(peerId, deps);
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
    try {
      logger.info(`🔄 Dialing bootstrap: ${addr.slice(0, 60)}...`);
      await deps.node.dial(addr);
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
    await new Promise(resolve => setTimeout(resolve, settleMs));
    
    const connections = deps.node.getConnections();
    const uniquePeers = new Set(connections.map((c: any) => c.remotePeer.toString()));
    logger.info(`✅ Bootstrap reconnection successful: ${uniquePeers.size} connection(s)`);
  }
  
  return successCount;
}

/**
 * Periodic check to ensure we maintain minimum connections
 */
export function startConnectionHealthCheck(deps: ReconnectionDependencies) {
  const CHECK_INTERVAL = 60000; // Check every 60 seconds

  // Stop any existing health check before starting a new one
  stopConnectionHealthCheck();

  healthCheckIntervalId = setInterval(async () => {
    const connections = deps.node.getConnections();
    const uniquePeers = new Set(connections.map((c: any) => c.remotePeer.toString()));
    const connectionCount = uniquePeers.size;
    const now = Date.now();

    // Only log if connection count changed
    if (connectionCount !== deps.lastConnectionCount) {
      logger.info(`📊 Connection health: ${connectionCount} unique peer(s) connected`);
      deps.lastConnectionCount = connectionCount;
    }

    if (connectionCount < deps.MIN_CONNECTIONS) {
      // Only warn if this is a new problem
      if (connectionCount !== deps.lastConnectionCount || connectionCount === 0) {
        logger.warn(`⚠️ Below minimum connections (${deps.MIN_CONNECTIONS}). Attempting to discover more peers...`);
      }

      // If we have zero connections, immediately try bootstrap
      if (connectionCount === 0) {
        logger.warn(`🚨 Zero connections! Reconnecting to bootstrap servers...`);
        await reconnectToBootstrap(deps);
        deps.lastBootstrapAttempt = now;
      }
      // If below minimum but > 0, try bootstrap periodically
      else if ((now - deps.lastBootstrapAttempt) > deps.BOOTSTRAP_RETRY_INTERVAL) {
        logger.info(`🔄 Attempting to connect to additional bootstrap servers...`);
        await reconnectToBootstrap(deps);
        deps.lastBootstrapAttempt = now;
      }

      // Also try reconnecting to known peers
      for (const [peerId, peerInfo] of deps.knownPeers) {
        if (!uniquePeers.has(peerId)) {
          const timeSinceLastSeen = now - peerInfo.lastSeen;
          const attemptInfo = deps.reconnectAttempts.get(peerId);

          // Only try peers we've seen recently and haven't exhausted attempts on
          if (timeSinceLastSeen < 3600000) { // 1 hour
            // Check if attempts have cooled down
            if (attemptInfo && attemptInfo.count >= deps.MAX_RECONNECT_ATTEMPTS) {
              if ((now - attemptInfo.lastAttempt) > deps.RECONNECT_COOLDOWN) {
                // Reset attempts after cooldown
                deps.reconnectAttempts.delete(peerId);
              } else {
                continue; // Skip this peer, still in cooldown
              }
            }

            try {
              logger.info(`🔄 Trying to reconnect to known peer ${peerId.slice(0, 16)}...`);

              if (peerInfo.multiaddrs.length > 0) {
                for (const addr of peerInfo.multiaddrs) {
                  try {
                    await deps.node.dial(addr);
                    logger.info(`✅ Reconnected to ${peerId.slice(0, 16)}...`);
                    break;
                  } catch {
                    // Try next address
                  }
                }
              } else {
                await deps.node.dial(peerId);
              }
            } catch (err) {
              // Track failed attempt
              const current = deps.reconnectAttempts.get(peerId) || { count: 0, lastAttempt: 0 };
              deps.reconnectAttempts.set(peerId, { count: current.count + 1, lastAttempt: now });
            }
          }
        }
      }
    }

    // Clean up old known peers (older than 24 hours)
    const ONE_DAY = 24 * 60 * 60 * 1000;
    for (const [peerId, peerInfo] of deps.knownPeers) {
      if (now - peerInfo.lastSeen > ONE_DAY) {
        deps.knownPeers.delete(peerId);
        deps.reconnectAttempts.delete(peerId);
      }
    }

    // Also clean up old reconnect attempts that have cooled down
    for (const [peerId, attemptInfo] of deps.reconnectAttempts) {
      if ((now - attemptInfo.lastAttempt) > deps.RECONNECT_COOLDOWN * 2) {
        deps.reconnectAttempts.delete(peerId);
      }
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
