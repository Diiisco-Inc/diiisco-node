import { tcp } from '@libp2p/tcp';
import { logger } from '../utils/logger';
import type { TCPComponents, TCPDialOptions, TCPOptions } from '@libp2p/tcp';
import type { Transport } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { Socket } from 'node:net';

/**
 * `@libp2p/tcp`, with the dial `AbortSignal` kept out of `net.connect()`.
 *
 * Under Bun — which is what every shipped binary runs on — an aborted TCP dial
 * kills the whole process. `@libp2p/tcp` builds its socket config by spreading
 * the entire dial options object:
 *
 *     const cOpts = multiaddrToNetConfig(ma, { ...this.opts.dialOpts, ...options })
 *     rawSocket = net.connect(cOpts)          // cOpts now carries options.signal
 *
 * so `net.connect()` receives the signal and takes responsibility for tearing
 * the socket down. Node wraps the abort reason in a real `AbortError` and, by
 * the time it would emit, libp2p has already destroyed the socket itself, so
 * nothing is emitted. Bun instead calls `socket.destroy(signal.reason)` with the
 * reason *verbatim* and defers the `'error'` event to the next tick — by which
 * point libp2p's own abort handler has run `done()`, which removes the socket's
 * `'error'` listener. The event lands on an emitter with no listener, and
 * because a `DOMException` is not a JSC `Error`, `node:events` raises
 * `ERR_UNHANDLED_ERROR` rather than rethrowing the abort. Nothing catches it and
 * the node disappears from the mesh.
 *
 * Every aborted dial is a candidate: the 30s keep-alive ping in `node.ts`, the
 * `dialProtocol` timeout in `messaging/directMessaging.ts`, kad-dht queries, and
 * the `@libp2p/random-walk` teardown AutoNAT triggers each time it stops walking.
 *
 * The fix is to make `signal` **non-enumerable** on the object `_connect()`
 * receives. Object spread copies only enumerable own properties, so the signal
 * never reaches `net.connect()` — while `_connect()`'s own direct reads
 * (`options.signal.throwIfAborted()`, `addEventListener`, `removeEventListener`)
 * are unaffected. Nothing is lost: libp2p already destroys the socket itself in
 * `_connect()`'s `.catch(() => rawSocket?.destroy())`.
 *
 * `_connect()` is wrapped rather than `dial()` because `dial()` hands the *same*
 * options object to `upgrader.upgradeOutbound()`, which spreads it too and
 * genuinely needs the signal to abort a stalled upgrade. Only the socket-config
 * spread must lose it.
 *
 * Upstream is not going to fix this: `@libp2p/tcp` 11.0.26 still spreads the
 * options and comments that it *relies* on `options.signal` destroying the
 * socket. `installProcessGuards()` in `src/utils/processGuards.ts` is the
 * backstop for the same failure arriving by another route.
 */
export function bunSafeTcp(init?: TCPOptions): (components: TCPComponents) => Transport {
  const createTransport = tcp(init);

  return (components: TCPComponents): Transport => {
    const transport = createTransport(components) as Transport & TCPInternals;
    const connect = transport._connect;

    if (typeof connect !== 'function') {
      // A future @libp2p/tcp could rename the method. Say so rather than
      // silently reverting to the crashing behaviour — the process guards still
      // catch the fallout, but this is the line that explains why they fired.
      logger.warn(
        '⚠️ @libp2p/tcp has no _connect() to wrap — aborted dials will pass their AbortSignal to net.connect()'
      );
      return transport;
    }

    transport._connect = (ma: Multiaddr, options: TCPDialOptions): Promise<Socket> =>
      connect.call(transport, ma, hideSignalFromSpread(options));

    return transport;
  };
}

/** The one internal of `@libp2p/tcp`'s transport we depend on. It is declared on the exported `TCP` class. */
interface TCPInternals {
  _connect?(ma: Multiaddr, options: TCPDialOptions): Promise<Socket>;
}

/**
 * A shallow copy of `options` whose `signal` survives property access but not
 * `{ ...options }`.
 *
 * `dial()` sets `keepAlive`, `noDelay` and `allowHalfOpen` on the original
 * before calling `_connect()`, and those are enumerable, so they are copied and
 * still reach `net.connect()`.
 */
function hideSignalFromSpread(options: TCPDialOptions): TCPDialOptions {
  if (options?.signal == null) return options;

  const { signal, ...rest } = options;
  const shielded = { ...rest } as unknown as TCPDialOptions;
  Object.defineProperty(shielded, 'signal', {
    value: signal,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return shielded;
}
