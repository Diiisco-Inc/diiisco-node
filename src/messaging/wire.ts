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

// ---------------------------------------------------------------------------
// Per-role payload shapes
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 128;
const MAX_STRING = 512;
const MAX_MULTIADDRS = 32;

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown, max = MAX_STRING): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A field that may be left out: absent, or null (what another encoder may send for "nothing"). */
const optional = (v: unknown, check: (x: unknown) => boolean): boolean => v === undefined || v === null || check(v);

/**
 * Why a message's *shape* is wrong for its role, or `null` if it is plausible.
 *
 * `parseWireMessage` only knows the envelope (role, wallet, signature). The
 * handlers behind it read fields of `payload` and assume their types, so a
 * stranger's message with a number where a string was expected would throw deep
 * inside one — or, worse, be accepted. This is the boundary check: each role's
 * payload is checked here, before any signature work or handler, and nothing
 * past it needs to wonder whether `payload.model` is a string. Deliberately
 * only a shape check; amounts, models and signatures are still verified by the
 * handlers against what this node issued. An unknown role returns `null` so
 * `process()` can report it as unknown.
 */
export function payloadProblem(msg: PubSubMessage): string | null {
  const m = msg as unknown as Record<string, any>;

  if (!isString(m.id, MAX_ID_LENGTH)) return 'id is missing or not a string';
  if (m.multiaddrs !== undefined && m.multiaddrs !== null) {
    if (!Array.isArray(m.multiaddrs) || m.multiaddrs.length > MAX_MULTIADDRS || !m.multiaddrs.every((a: unknown) => isString(a, 256))) {
      return 'multiaddrs is not a short list of strings';
    }
  }

  const p = m.payload;
  switch (m.role) {
    case 'list-models':
    case 'list-network':
      return null;

    case 'quote-request':
      if (!isObject(p)) return 'payload is not an object';
      if (!isString(p.model, 256)) return 'payload.model is not a string';
      if (!isFiniteNumber(p.inputTokenCount) || p.inputTokenCount < 0) return 'payload.inputTokenCount is not a number';
      if (!optional(p.maxSpend, isFiniteNumber)) return 'payload.maxSpend is not a number';
      if (!optional(p.max_tokens, isFiniteNumber)) return 'payload.max_tokens is not a number';
      if (p.kind !== undefined && p.kind !== null && p.kind !== 'systemone') return 'payload.kind is not a known kind';
      return null;

    case 'quote-response':
      if (!isObject(p) || !isObject(p.quote)) return 'payload.quote is not an object';
      return null;

    case 'quote-accepted':
      if (!isObject(p)) return 'payload is not an object';
      if (!isString(p.model, 256)) return 'payload.model is not a string';
      return null;

    case 'contract-created':
      if (!isObject(p) || !isObject(p.paymentRequirements)) return 'payload.paymentRequirements is not an object';
      return null;

    case 'contract-signed':
      if (!isObject(p)) return 'payload is not an object';
      if (!optional(p.paymentPayload, isObject)) return 'payload.paymentPayload is not an object';
      return null;

    case 'inference-response':
      if (!isObject(p) || p.completion === undefined) return 'payload.completion is missing';
      return null;

    case 'inference-failed':
      if (!isObject(p)) return 'payload is not an object';
      if (!optional(p.model, (x) => isString(x, 256))) return 'payload.model is not a string';
      return null;

    case 'list-models-response':
      if (!isObject(p) || !Array.isArray(p.models)) return 'payload.models is not a list';
      return null;

    case 'list-network-response':
      if (!isObject(p) || !isObject(p.node) || !isString(p.node.peerId, 128)) return 'payload.node is not a node';
      return null;

    case 'node-profile':
      if (!isObject(p) || !isString(p.peerId, 128)) return 'payload.peerId is not a string';
      return null;

    case 'node-profile-response':
      if (!isObject(p) || !isObject(p.profile) || !isString(p.profile.peerId, 128)) return 'payload.profile is not a profile';
      return null;

    default:
      return null;
  }
}
