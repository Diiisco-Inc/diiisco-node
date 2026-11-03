/**
 * What to say when a connection closes, so an operator can tell a relay
 * cutting a connection (it closes at a round number of seconds after it
 * opened, and the address contains `/p2p-circuit`) from a peer going away.
 */

export interface ClosedConnection {
  remotePeer: { toString(): string };
  remoteAddr: { toString(): string };
  timeline?: { open?: number };
  /** Set on a relayed connection: the relay's duration and data limits. */
  limits?: { seconds?: bigint; bytes?: bigint };
}

export const isRelayedAddress = (addr: string): boolean => addr.includes('/p2p-circuit');

export interface CloseDescription {
  relayed: boolean;
  message: string;
}

/**
 * A line describing a closed connection: how long it lasted and, when relayed,
 * the relay's limit. A relayed connection that closes within a few seconds of
 * its duration limit was cut by the relay, and says so.
 */
export function describeClose(conn: ClosedConnection, now: number = Date.now()): CloseDescription {
  const relayed = isRelayedAddress(conn.remoteAddr.toString());
  const peer = conn.remotePeer.toString().slice(0, 16);
  const opened = conn.timeline?.open;
  const lasted = typeof opened === 'number' ? Math.max(0, Math.round((now - opened) / 1000)) : undefined;
  const duration = lasted === undefined ? '' : ` after ${lasted}s`;

  if (!relayed) return { relayed, message: `🔌 Connection to ${peer}... closed${duration}` };

  const limitSeconds = conn.limits?.seconds === undefined ? undefined : Number(conn.limits.seconds);
  const atLimit = lasted !== undefined && limitSeconds !== undefined && Math.abs(lasted - limitSeconds) <= 5;
  const limit = limitSeconds === undefined ? '' : ` (relay limit ${limitSeconds}s)`;
  const cause = atLimit ? ' — cut by the relay at its duration limit' : '';
  return { relayed, message: `🛰️ Relayed connection to ${peer}... closed${duration}${limit}${cause}` };
}
