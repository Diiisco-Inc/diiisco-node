/**
 * A snapshot of who the node is connected to, for `diiisco peers`.
 *
 * Peer ids are public (they are in every message the node sends), but the list
 * still says where the node sits in the network, so it is only served over the
 * daemon's token-protected loopback control channel.
 */
import { isRelayedAddress } from './connectionLog';
import type { DialingNode } from './dialTarget';

export interface PeerEntry {
  peerId: string;
  /** At least one connection to this peer is not through a relay. */
  direct: boolean;
  /** Every connection to this peer is through a relay, so the relay's limits apply. */
  relayedOnly: boolean;
  /** One of the configured bootstrap servers. */
  bootstrap: boolean;
}

export interface PeerReport {
  connected: number;
  direct: number;
  relayedOnly: number;
  /** Bootstrap servers currently connected, and how many are configured. */
  bootstrapConnected: number;
  bootstrapTotal: number;
  /** Connections the node aims to hold. */
  target: number;
  /** Peers remembered for redialling. */
  known: number;
  peers: PeerEntry[];
}

/** What a manual reconnect did. */
export interface ReconnectReport {
  before: number;
  after: number;
  report: PeerReport;
}

export function buildPeerReport(
  node: DialingNode,
  options: { bootstrapPeerIds: Iterable<string>; target: number; known: number },
): PeerReport {
  const bootstrap = new Set(options.bootstrapPeerIds);
  const byPeer = new Map<string, { direct: boolean }>();

  for (const conn of node.getConnections() as Array<{ remotePeer: { toString(): string }; remoteAddr?: { toString(): string } }>) {
    const id = conn.remotePeer.toString();
    const direct = conn.remoteAddr === undefined ? true : !isRelayedAddress(conn.remoteAddr.toString());
    const seen = byPeer.get(id);
    byPeer.set(id, { direct: (seen?.direct ?? false) || direct });
  }

  const peers: PeerEntry[] = [...byPeer.entries()]
    .map(([peerId, { direct }]) => ({ peerId, direct, relayedOnly: !direct, bootstrap: bootstrap.has(peerId) }))
    .sort((a, b) => Number(b.bootstrap) - Number(a.bootstrap) || a.peerId.localeCompare(b.peerId));

  return {
    connected: peers.length,
    direct: peers.filter((p) => p.direct).length,
    relayedOnly: peers.filter((p) => p.relayedOnly).length,
    bootstrapConnected: peers.filter((p) => p.bootstrap).length,
    bootstrapTotal: bootstrap.size,
    target: options.target,
    known: options.known,
    peers,
  };
}
