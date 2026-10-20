import { logger } from '../utils/logger';
import { PUBLIC_NETWORK_ID } from '../utils/topic';

/**
 * Keeps the public network and private (`local.enabled`) clusters apart at the
 * connection level.
 *
 * The GossipSub topic only separates *messages*. Without this, a private node
 * and a public node on the same wifi find each other over mDNS, connect, and
 * the private node is then reachable by, and walks, the public network.
 *
 * Every node registers a marker protocol, `/diiisco/network/<id>/1.0.0`, which
 * identify advertises to its peers. Once a peer has been identified:
 *
 * - a **private** node (strict) keeps only peers advertising *its* marker, or
 *   peers it was explicitly configured to use (its own bootstrap servers);
 * - a **public** node drops peers advertising a different network's marker, and
 *   keeps peers advertising none (nodes that predate the marker).
 *
 * The private side enforces this on its own, so it holds even when the public
 * node runs an older version. Peers are identified by peer id, never wallet.
 */

const MARKER_PREFIX = '/diiisco/network/';
const MARKER_SUFFIX = '/1.0.0';

/** How long a refused peer stays refused. */
const DENY_TTL_MS = 10 * 60 * 1000;

export const markerProtocol = (networkId: string): string => `${MARKER_PREFIX}${networkId}${MARKER_SUFFIX}`;

/**
 * Whether a node on `ownNetworkId` should keep a peer that advertises
 * `protocols`. Pure, so the rules can be tested without a libp2p node.
 */
export function judgePeer(ownNetworkId: string, protocols: string[]): 'allow' | 'deny' {
  if (protocols.includes(markerProtocol(ownNetworkId))) return 'allow';
  // A private node is strict: no marker of its own, no connection.
  if (ownNetworkId !== PUBLIC_NETWORK_ID) return 'deny';
  // The public network accepts old nodes (no marker) but not another network's.
  const foreign = protocols.some((p) => p.startsWith(MARKER_PREFIX) && p.endsWith(MARKER_SUFFIX));
  return foreign ? 'deny' : 'allow';
}

/** The peer ids named in a list of multiaddrs (`…/p2p/<id>`). */
export function bootstrapPeerIds(addrs: string[]): string[] {
  const ids: string[] = [];
  for (const addr of addrs) {
    const match = /\/p2p\/([^/]+)/.exec(addr);
    if (match) ids.push(match[1]);
  }
  return ids;
}

let activeGuard: NetworkGuard | null = null;

/** Whether the running node has refused this peer. `false` before a node exists. */
export const isPeerDenied = (peerId: string): boolean => activeGuard?.isDenied(peerId) ?? false;

export class NetworkGuard {
  private readonly denied = new Map<string, number>();
  private readonly exempt: Set<string>;

  constructor(
    readonly networkId: string,
    exemptPeerIds: string[] = [],
    private readonly ttlMs: number = DENY_TTL_MS,
  ) {
    this.exempt = new Set(exemptPeerIds);
  }

  isDenied(peerId: string, now: number = Date.now()): boolean {
    const until = this.denied.get(peerId);
    if (until === undefined) return false;
    if (until <= now) {
      this.denied.delete(peerId);
      return false;
    }
    return true;
  }

  /** Decide on an identified peer; remembers a refusal. */
  evaluate(peerId: string, protocols: string[], now: number = Date.now()): 'allow' | 'deny' {
    if (this.exempt.has(peerId)) return 'allow';
    const verdict = judgePeer(this.networkId, protocols);
    if (verdict === 'deny') this.denied.set(peerId, now + this.ttlMs);
    else this.denied.delete(peerId);
    return verdict;
  }

  /** For libp2p's `connectionGater` option: refuses dials to, and connections from, a refused peer. */
  gater() {
    return {
      denyDialPeer: (peerId: any) => this.isDenied(peerId.toString()),
      denyInboundUpgradedConnection: (peerId: any) => this.isDenied(peerId.toString()),
    };
  }

  /**
   * Advertise this node's marker and start judging identified peers. Never
   * throws: an unhandled rejection exits the process.
   */
  async attach(node: any): Promise<void> {
    activeGuard = this;
    try {
      await node.handle(markerProtocol(this.networkId), (arg: any) => {
        try { (arg?.stream ?? arg)?.close?.(); } catch { /* nothing to say on this protocol */ }
      });
    } catch (err: any) {
      logger.warn(`⚠️ Could not register the network marker protocol: ${err?.message ?? err}`);
    }

    node.addEventListener('peer:identify', (evt: any) => {
      void this.onIdentify(node, evt?.detail);
    });
  }

  private async onIdentify(node: any, result: { peerId?: any; protocols?: string[] } | undefined): Promise<void> {
    try {
      if (!result?.peerId) return;
      const peerId = result.peerId.toString();
      if (this.evaluate(peerId, result.protocols ?? []) === 'allow') return;

      logger.info(`🚧 Refusing peer ${peerId.slice(0, 16)}... — it is not on this node's network (${this.networkId})`);
      try { await node.hangUp(result.peerId); } catch { /* already gone */ }
      try { await node.peerStore.delete(result.peerId); } catch { /* not stored */ }
    } catch (err: any) {
      logger.warn(`⚠️ Network check failed: ${err?.message ?? err}`);
    }
  }
}
