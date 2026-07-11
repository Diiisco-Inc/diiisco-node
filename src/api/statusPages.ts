import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { sha256 } from 'js-sha256';
import { peerIdFromString } from '@libp2p/peer-id';
import environment from '../environment/environment';
import algorand from '../utils/algorand';
import { MessageRouter } from '../messaging/messageRouter';
import { buildOwnProfile } from '../utils/nodeProfile';
import { NodeProfile, DirectoryEntry } from '../types/profile';
import { NodeProfileRequest, NetworkNode } from '../types/messages';
import { logger } from '../utils/logger';

/**
 * Public, unauthenticated status pages: this node's home page, a directory of
 * known nodes, and per-node profile pages — on relay hosts these serve
 * {relay_host}/nodes/{peerId} for private nodes reachable only via the relay.
 * The HTML routes serve the built web app from dist/web; the .json routes are
 * the data API the app consumes. These paths must NOT be added to the
 * requireBearer prefix list in server.ts.
 */

const PROFILE_WAIT_DEFAULT = 3000;
const PROFILE_CACHE_TTL_DEFAULT = 45_000;
const NEGATIVE_CACHE_TTL = 10_000;
const RATE_LIMIT_CAPACITY = 30;          // burst
const RATE_LIMIT_REFILL_PER_MS = 30 / 60_000; // 30 requests/minute

interface KnownNodeSighting {
  peerId: string;
  displayName?: string;
  nfd?: string;
  walletAddr?: string;
  role?: NodeProfile['role'];
  network?: NodeProfile['network'];
  lastSeen: number;
}

interface StatusPagesDeps {
  app: Express;
  node: any;
  nodeEvents: EventEmitter;
  algo: algorand;
  messageRouter: MessageRouter;
  availableModels: string[];
}

export const registerStatusPages = ({ app, node, nodeEvents, algo, messageRouter, availableModels }: StatusPagesDeps) => {
  const ownPeerId = node.peerId.toString();
  const profileWaitTime = environment.api.profileWaitTime || PROFILE_WAIT_DEFAULT;
  const profileCacheTtl = environment.api.profileCacheTtl || PROFILE_CACHE_TTL_DEFAULT;

  // ---- Known-nodes registry -------------------------------------------------
  // Passive sightings from list-network responses (identity only) plus live
  // connections at query time form the /nodes directory. Profile responses
  // also feed it so a successfully-queried node stays listed after it
  // disconnects.
  const knownNodes = new Map<string, KnownNodeSighting>();

  const recordSighting = (s: { peerId: string; displayName?: string; nfd?: string; walletAddr?: string; role?: NodeProfile['role']; network?: NodeProfile['network'] }) => {
    if (!s.peerId || s.peerId === ownPeerId) return;
    const existing = knownNodes.get(s.peerId);
    knownNodes.set(s.peerId, {
      peerId: s.peerId,
      displayName: s.displayName ?? existing?.displayName,
      nfd: s.nfd ?? existing?.nfd,
      walletAddr: s.walletAddr ?? existing?.walletAddr,
      role: s.role ?? existing?.role,
      network: s.network ?? existing?.network,
      lastSeen: Date.now(),
    });
  };

  nodeEvents.on('network-node-received', (n: NetworkNode) => recordSighting(n));

  // ---- Profile cache + single-flight ----------------------------------------
  const profileCache = new Map<string, { profile: NodeProfile; expiresAt: number }>();
  const negativeCache = new Map<string, number>();
  const inflight = new Map<string, Promise<NodeProfile | null>>();

  const fetchRemoteProfile = async (peerId: string): Promise<NodeProfile | null> => {
    const request: NodeProfileRequest = {
      role: 'node-profile',
      to: peerId,
      timestamp: Date.now(),
      id: sha256(`${Date.now()}-node-profile-${peerId}-${Math.random()}`).slice(0, 56),
      fromWalletAddr: algo.account.addr.toString(),
      payload: { peerId },
    };
    request.signature = await algo.signObject(request);

    return new Promise<NodeProfile | null>((resolve) => {
      const eventName = `node-profile-received-${request.id}`;
      const timer = setTimeout(() => {
        nodeEvents.removeAllListeners(eventName);
        resolve(null);
      }, profileWaitTime);

      nodeEvents.once(eventName, (profile: NodeProfile) => {
        clearTimeout(timer);
        resolve(profile);
      });

      messageRouter.sendMessage(request, peerId).catch((err: Error) => {
        logger.debug(`Could not send node-profile to ${peerId.slice(0, 16)}...: ${err.message}`);
        clearTimeout(timer);
        nodeEvents.removeAllListeners(eventName);
        resolve(null);
      });
    });
  };

  /**
   * Resolve a profile for any peer: self in-process, otherwise cached or via a
   * live node-profile query. Returns an offline identity-only profile for
   * known-but-unreachable nodes, or null for unknown peers (→ 404).
   */
  const getProfile = async (peerId: string): Promise<NodeProfile | null> => {
    if (peerId === ownPeerId) {
      return buildOwnProfile(node, algo, availableModels);
    }

    const cached = profileCache.get(peerId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.profile;
    }

    const offlineFallback = (): NodeProfile | null => {
      const known = knownNodes.get(peerId);
      if (!known) return null;
      return {
        peerId,
        displayName: known.displayName,
        nfd: known.nfd,
        walletAddr: known.walletAddr,
        role: known.role ?? 'direct',
        online: false,
        network: known.network ?? 'public',
        observedAt: new Date(known.lastSeen).toISOString(),
      };
    };

    if ((negativeCache.get(peerId) ?? 0) > Date.now()) {
      return offlineFallback();
    }

    let pending = inflight.get(peerId);
    if (!pending) {
      pending = fetchRemoteProfile(peerId).finally(() => inflight.delete(peerId));
      inflight.set(peerId, pending);
    }

    const profile = await pending;
    if (profile) {
      profileCache.set(peerId, { profile, expiresAt: Date.now() + profileCacheTtl });
      recordSighting(profile);
      return profile;
    }

    negativeCache.set(peerId, Date.now() + NEGATIVE_CACHE_TTL);
    return offlineFallback();
  };

  const getDirectory = (): DirectoryEntry[] => {
    const entries = new Map<string, DirectoryEntry>();

    for (const sighting of knownNodes.values()) {
      entries.set(sighting.peerId, {
        peerId: sighting.peerId,
        displayName: sighting.displayName,
        nfd: sighting.nfd,
        walletAddr: sighting.walletAddr,
        connected: false,
        role: sighting.role,
        lastSeen: sighting.lastSeen,
      });
    }

    for (const conn of node.getConnections()) {
      const peerId = conn.remotePeer.toString();
      if (peerId === ownPeerId) continue;
      const relayed = conn.remoteAddr.toString().includes('/p2p-circuit');
      const entry: DirectoryEntry = entries.get(peerId) ?? { peerId, connected: true, lastSeen: Date.now() };
      entry.connected = true;
      entry.lastSeen = Date.now();
      entry.role = relayed ? 'relayed' : 'direct';
      entries.set(peerId, entry);
    }

    return [...entries.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastSeen - a.lastSeen);
  };

  // ---- Rate limiting ---------------------------------------------------------
  // Simple per-IP token bucket on the proxy-lookup route so an HTTP crawler
  // can't turn this node into a mesh-query amplifier.
  const buckets = new Map<string, { tokens: number; last: number }>();

  const rateLimit = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(ip) ?? { tokens: RATE_LIMIT_CAPACITY, last: now };
    bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + (now - bucket.last) * RATE_LIMIT_REFILL_PER_MS);
    bucket.last = now;

    if (bucket.tokens < 1) {
      buckets.set(ip, bucket);
      return res.status(429).json({ error: 'Too many requests' });
    }
    bucket.tokens -= 1;
    buckets.set(ip, bucket);

    // Opportunistic cleanup of idle buckets
    if (buckets.size > 1000) {
      for (const [key, b] of buckets) {
        if (now - b.last > 120_000) buckets.delete(key);
      }
    }
    next();
  };

  // ---- Web app shell + static assets -----------------------------------------
  const webDist = join(dirname(fileURLToPath(import.meta.url)), 'web');
  const shellPath = join(webDist, 'index.html');

  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1y', immutable: true }));
  }

  // Scripts stay locked to 'self' (the XSS backstop); brand assets load from
  // the DIIISCO asset host and Google Fonts, so those origins are allowlisted.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https://asset.diiisco.com",
    "connect-src 'self'",
  ].join('; ');

  const sendShell = (res: Response) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-cache');
    if (existsSync(shellPath)) {
      res.sendFile(shellPath);
    } else {
      // Dev checkout without a web build — never fail over a missing frontend.
      res.status(200).send(
        '<!doctype html><title>DIIISCO Node</title><p>This is a DIIISCO node. The status page UI is not built — see <a href="/node.json">/node.json</a> and <a href="/nodes.json">/nodes.json</a>, or run <code>npm run build:web</code>.</p>'
      );
    }
  };

  const sendJson = (res: Response, body: unknown, status = 200) => {
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.status(status).json(body);
  };

  // ---- Routes -----------------------------------------------------------------
  app.get('/', (_req, res) => sendShell(res));

  app.get('/node.json', (_req, res) => {
    sendJson(res, buildOwnProfile(node, algo, availableModels));
  });

  app.get('/nodes.json', (_req, res) => {
    sendJson(res, { object: 'list', data: getDirectory() });
  });

  app.get('/nodes', (req, res) => {
    if (req.accepts(['html', 'json']) === 'json') {
      return sendJson(res, { object: 'list', data: getDirectory() });
    }
    sendShell(res);
  });

  app.get('/nodes/:peerId', rateLimit, async (req, res) => {
    const raw = req.params.peerId;
    const wantsJson = raw.endsWith('.json') || req.accepts(['html', 'json']) === 'json';
    const peerId = raw.endsWith('.json') ? raw.slice(0, -'.json'.length) : raw;

    try {
      peerIdFromString(peerId);
    } catch {
      return res.status(400).json({ error: 'Invalid peer ID' });
    }

    if (!wantsJson) {
      // The web app shell fetches /nodes/{peerId}.json itself.
      return sendShell(res);
    }

    try {
      const profile = await getProfile(peerId);
      if (!profile) {
        return res.status(404).json({ error: 'Unknown node' });
      }
      sendJson(res, profile);
    } catch (err: any) {
      logger.error(`Error fetching profile for ${peerId.slice(0, 16)}...: ${err.message}`);
      res.status(500).json({ error: 'Error fetching node profile' });
    }
  });

  logger.info('📄 Public status pages enabled at /, /nodes and /nodes/{peerId}');
};
