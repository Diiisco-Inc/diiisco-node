import { multiaddr, isMultiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { isPeerId, type PeerId } from '@libp2p/interface';
import { logger } from '../utils/logger';

/**
 * What `libp2p.dial()` accepts. A plain string is not one of these: libp2p 3.x
 * calls `getComponents()` on the argument and throws on a string, which is how
 * every reconnect and bootstrap redial used to fail without saying why.
 */
export type DialTarget = PeerId | Multiaddr;

/** The slice of the libp2p node that reconnection needs; `dial` takes a `DialTarget`, never a string. */
export interface DialingNode {
  dial(target: DialTarget): Promise<unknown>;
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  services?: any;
}

/**
 * Turn a stored address (`/ip4/…/p2p/<id>`) or a peer id string into something
 * `dial()` accepts. Returns `null` for a malformed entry, so one bad value in
 * `knownPeers` or the bootstrap list cannot abort a loop over the rest.
 */
export function toDialTarget(value: string | DialTarget): DialTarget | null {
  if (isPeerId(value) || isMultiaddr(value)) return value;

  try {
    // A multiaddr always starts with a slash; a peer id never does.
    return value.startsWith('/') ? multiaddr(value) : peerIdFromString(value);
  } catch (err: any) {
    logger.warn(`⚠️ Ignoring an address that cannot be dialled (${String(value).slice(0, 60)}): ${err?.message ?? err}`);
    return null;
  }
}
