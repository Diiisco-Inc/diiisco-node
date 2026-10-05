import { decode } from 'msgpackr';
import type { PubSubMessage } from '../types/messages';

/**
 * Decode and shape-check one message off the wire. Returns `null` for anything
 * that is not a plausible DIIISCO message, so the caller can drop it.
 *
 * Every byte here comes from an arbitrary peer, and unhandled rejections exit
 * the process (`installProcessGuards`): a decode that throws, or a message that
 * is a bare number where an object was assumed, would otherwise let one peer
 * knock a node off the network. This is deliberately only a *shape* check —
 * the signature, the sender and the payload are verified by `process()`.
 */
export function parseWireMessage(data: Uint8Array): PubSubMessage | null {
  let msg: unknown;
  try {
    msg = decode(data);
  } catch {
    return null;
  }
  return isWireMessage(msg) ? msg : null;
}

export function isWireMessage(msg: unknown): msg is PubSubMessage {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.role === 'string' &&
    typeof m.fromWalletAddr === 'string' &&
    typeof m.signature === 'string' &&
    (m.to === undefined || typeof m.to === 'string')
  );
}

/** Who a message is addressed to, or `undefined` for a broadcast (not every role has a `to`). */
export const addressedTo = (msg: PubSubMessage): string | undefined => (msg as { to?: string }).to;
