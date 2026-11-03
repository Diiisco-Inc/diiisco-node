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

describe('direct messaging', () => {
  const nodes: any[] = [];
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop().catch(() => {})));
  });

  async function pair(onMessage: (n: number) => void = () => {}) {
    const a = await makeNode();
    const b = await makeNode();
    nodes.push(a, b);
    let received = 0;
    const receiver = new DirectMessagingHandler(a, async () => { received += 1; onMessage(received); });
    await receiver.registerProtocol();
    const sender = new DirectMessagingHandler(b, async () => {});
    await b.dial(a.getMultiaddrs()[0]);
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
});
