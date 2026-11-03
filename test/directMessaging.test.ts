/**
 * Direct messages between two real libp2p nodes (`src/messaging/directMessaging.ts`).
 *
 * Every direct message opens a fresh stream. libp2p allows 32 inbound streams
 * per protocol per connection and resets any further one after negotiating it,
 * so if finished streams are not fully closed they pile up and sends start
 * failing with "Cannot write to a stream that is closed" (issue #101).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { noise } from '@chainsafe/libp2p-noise';
import { identify } from '@libp2p/identify';
import { tcp } from '@libp2p/tcp';
import { yamux } from '@libp2p/yamux';
import { createLibp2p } from 'libp2p';
import { lpStream } from '@libp2p/utils';
import { DirectMessagingHandler } from '../src/messaging/directMessaging';
import { DEFAULT_DIRECT_MESSAGING_CONFIG } from '../src/utils/defaults';
import { sleep } from './helpers';

const PROTOCOL = DEFAULT_DIRECT_MESSAGING_CONFIG.protocol;

/** A wire-valid message: `parseWireMessage` only checks the shape. */
const message = (n = 0): any => ({ role: 'node-profile', fromWalletAddr: 'WALLET', signature: `sig-${n}` });

async function makeNode(): Promise<any> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

/** Direct-message streams the muxer still lists on any connection of `node`. */
const openDirectStreams = (node: any): number =>
  node.getConnections().flatMap((c: any) => c.streams).filter((s: any) => s.protocol === PROTOCOL).length;

/** Wait for `check` to hold, up to `ms`. */
async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

/**
 * Dial `target` and wait for the connection to go quiet. Identify runs its own
 * streams as soon as a connection opens; stopping a node while one is still
 * negotiating, with the other end already gone, makes `stop()` wait on it.
 */
async function connect(from: any, target: any): Promise<void> {
  await from.dial(target.getMultiaddrs()[0]);
  await until(() => [from, target].every((n) => n.getConnections().every((c: any) => c.streams.length === 0)));
}

describe('direct messaging', () => {
  const nodes: any[] = [];
  afterEach(async () => {
    // Bounded: after several reset streams a node's `stop()` can wait on a
    // stream that never finishes, and that must not hide a test's own result.
    await Promise.all(nodes.splice(0).map((n) => Promise.race([n.stop().catch(() => {}), sleep(2000)])));
  });

  async function pair(onMessage: (n: number) => void = () => {}) {
    const a = await makeNode();
    const b = await makeNode();
    nodes.push(a, b);
    let received = 0;
    const receiver = new DirectMessagingHandler(a, async () => { received += 1; onMessage(received); });
    await receiver.registerProtocol();
    const sender = new DirectMessagingHandler(b, async () => {});
    await connect(b, a);
    return { a, b, sender, receiver, received: () => received };
  }

  test('40 messages over one connection all arrive, and the streams are cleaned up', async () => {
    const { a, b, sender, received } = await pair();

    const results: boolean[] = [];
    for (let i = 0; i < 40; i++) results.push(await sender.sendDirect(a.peerId.toString(), message(i)));

    expect(results.filter((ok) => !ok)).toHaveLength(0);
    expect(await until(() => received() === 40)).toBe(true);

    // Finished exchanges must leave nothing behind on either end.
    expect(await until(() => openDirectStreams(a) === 0 && openDirectStreams(b) === 0)).toBe(true);
  }, 60_000);

  test('a peer on an older build that never closes its end cannot pin the sender\'s streams', async () => {
    const a = await makeNode();
    const b = await makeNode();
    nodes.push(a, b);

    // The 1.0.11 handler: read one message and return, leaving the stream open.
    let received = 0;
    await a.handle(PROTOCOL, (stream: any) => {
      lpStream(stream).read().then(() => { received += 1; }).catch(() => {});
    }, { runOnLimitedConnection: true });

    const sender = new DirectMessagingHandler(b, async () => {}, { streamGraceMs: 30 });
    await connect(b, a);

    // Paced like the real thing (a few messages in flight, not 40 at once).
    const results: boolean[] = [];
    for (let i = 0; i < 40; i++) {
      results.push(await sender.sendDirect(a.peerId.toString(), message(i)));
      await sleep(15);
    }

    expect(results.filter((ok) => !ok)).toHaveLength(0);
    expect(received).toBe(40);
    expect(await until(() => openDirectStreams(a) === 0 && openDirectStreams(b) === 0)).toBe(true);
  }, 60_000);

  describe('a stream that is closed under the sender', () => {
    /** Make the first `times` dialProtocol calls hand back a stream that has already been reset. */
    function breakFirstStreams(node: any, times: number) {
      const real = node.dialProtocol.bind(node);
      const state = { calls: 0 };
      node.dialProtocol = async (...args: any[]) => {
        state.calls += 1;
        const stream = await real(...args);
        if (state.calls <= times) stream.abort(new Error('reset by the test'));
        return stream;
      };
      return state;
    }

    test('is retried once on a fresh stream, and the message still arrives', async () => {
      const { a, b, sender, received } = await pair();
      const state = breakFirstStreams(b, 1);

      expect(await sender.sendDirect(a.peerId.toString(), message())).toBe(true);
      expect(state.calls).toBe(2);
      expect(await until(() => received() === 1)).toBe(true);
    }, 30_000);

    test('is given up on after one retry, so the caller can fall back to GossipSub', async () => {
      const { a, b, sender } = await pair();
      const state = breakFirstStreams(b, 5);

      expect(await sender.sendDirect(a.peerId.toString(), message())).toBe(false);
      expect(state.calls).toBe(2);
    }, 30_000);
  });

  test('an error that is not about the stream is not retried', async () => {
    const { a, b, sender } = await pair();
    let calls = 0;
    b.dialProtocol = async () => { calls += 1; throw new Error('boom'); };

    expect(await sender.sendDirect(a.peerId.toString(), message())).toBe(false);
    expect(calls).toBe(1);
  }, 30_000);
});
