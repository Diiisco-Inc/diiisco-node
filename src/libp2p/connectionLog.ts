/**
 * What to say when a connection closes, so an operator can tell a relay
 * cutting a connection (it closes at a round number of seconds after it
 * opened, and the address contains `/p2p-circuit`) from a peer going away.
 */

export interface ClosedConnection {
  remotePeer: { toString(): string };
  remoteAddr: { toString(): string };
  timeline?: { open?: number };
  /**
   * Set on a relayed connection. libp2p exposes `seconds` as a live getter: the
   * time *remaining* when it is read (a number), not the limit the relay set.
   */
  limits?: { seconds?: number | bigint; bytes?: number | bigint };
}

export const isRelayedAddress = (addr: string): boolean => addr.includes('/p2p-circuit');

export interface CloseDescription {
  relayed: boolean;
  message: string;
}

/**
 * The relay's duration limit in seconds, worked back from what libp2p reports.
 *
 * `limits.seconds` is the time remaining, so the limit is that plus how long
 * the connection lasted. js-libp2p's relay server (which every DIIISCO relay
 * runs) puts its limit in *milliseconds* into a field the protocol defines in
 * seconds, so the figure comes out 1000 times too large (a 10 minute limit
 * reads 600000). A figure of a minute or more once divided by 1000 is taken to
 * be that; anything smaller is taken at face value, as a relay that sends
 * seconds correctly would give.
 */
export function relayLimitSeconds(lastedSeconds: number, remaining: number | bigint | undefined): number | undefined {
  if (remaining === undefined) return undefined;
  const reported = lastedSeconds + Number(remaining);
  if (!Number.isFinite(reported) || reported <= 0) return undefined;
  const fromMilliseconds = reported / 1000;
  return fromMilliseconds >= 60 ? Math.round(fromMilliseconds) : Math.round(reported);
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

  // Without how long it lasted the remaining time cannot be turned into a limit.
  const limitSeconds = lasted === undefined ? undefined : relayLimitSeconds(lasted, conn.limits?.seconds);
  const atLimit = lasted !== undefined && limitSeconds !== undefined && Math.abs(lasted - limitSeconds) <= 5;
  const limit = limitSeconds === undefined ? '' : ` (relay limit ${limitSeconds}s)`;
  const cause = atLimit ? ' — cut by the relay at its duration limit' : '';
  return { relayed, message: `🛰️ Relayed connection to ${peer}... closed${duration}${limit}${cause}` };
}
