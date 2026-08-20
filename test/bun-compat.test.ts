/**
 * The Bun compatibility risks the spec calls release-blocking (§5.3).
 *
 * Bun's Node-API surface is broad but not identical to Node 22, and these are
 * the places the dependency tree actually depends on the difference:
 *
 *   1. `node:net` socket behaviour used by `@libp2p/tcp`
 *   2. `node:dgram` multicast used by `@libp2p/mdns` — the one local-mode
 *      discovery depends on, and the most likely to differ
 *   3. the absence of `process.send` (the PM2 readiness signal is guarded)
 *   4. `node:crypto`'s missing chacha20-poly1305 cipher, which the noise
 *      encrypter reaches for on payloads >= 1200 bytes
 *
 * They are asserted here rather than left to a one-off manual check, so a Bun
 * upgrade that regresses any of them fails CI instead of shipping. Item 2 skips
 * where the host cannot do multicast at all (container networks, locked-down
 * runners): that is an environment limitation, not a Bun regression.
 */
import { describe, expect, test } from 'bun:test';
import { noise, pureJsCrypto } from '@chainsafe/libp2p-noise';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { tcp } from '@libp2p/tcp';
import { lpStream } from '@libp2p/utils';
import { yamux } from '@libp2p/yamux';
import { createLibp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { multicastAvailable } from './helpers';

/**
 * Each test owns its nodes and stops them before the next one starts. mDNS
 * instances share UDP 5353, and leaving earlier nodes responding on it makes
 * discovery results depend on test order.
 */
async function withNodes<T>(
  count: number,
  serviceTag: string,
  body: (nodes: any[]) => Promise<T>,
  // Defaults to the package default so the net/mDNS tests keep exercising it;
  // the chacha test passes src/libp2p/node.ts's production choice instead.
  encrypter: any = noise()
): Promise<T> {
  const nodes = await Promise.all(
    Array.from({ length: count }, () =>
      createLibp2p({
        // 0.0.0.0, not 127.0.0.1: @libp2p/mdns does not advertise a
        // loopback-only node, so a localhost listener would pass the TCP test
        // and silently fail the discovery one.
        addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
        transports: [tcp()],
        connectionEncrypters: [encrypter],
        streamMuxers: [yamux()],
        peerDiscovery: [mdns({ serviceTag, interval: 1000 })],
        services: { identify: identify() },
      })
    )
  );

  try {
    return await body(nodes);
  } finally {
    await Promise.all(nodes.map((node) => node.stop().catch(() => {})));
  }
}

/** A tag unique to this run, so the probe never joins the real DIIISCO service. */
function uniqueTag(): string {
  return `diiisco-test-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Bun compatibility (§5.3)', () => {
  test('process.send is absent, so the PM2 readiness guard is a no-op', () => {
    // src/index.ts ends with `if (process.send) process.send('ready')`. Under a
    // compiled binary there is no IPC channel; the guard must simply not fire.
    expect(process.send).toBeUndefined();
  });

  test('node:net — libp2p listens on TCP and accepts a dial', async () => {
    await withNodes(2, uniqueTag(), async ([a, b]) => {
      const listen = a.getMultiaddrs().map(String);
      expect(listen.length).toBeGreaterThan(0);
      expect(listen.some((addr: string) => addr.includes('/tcp/'))).toBe(true);

      const connection = await b.dial(a.getMultiaddrs()[0]);
      expect(connection.status).toBe('open');
      expect(connection.remotePeer.toString()).toBe(a.peerId.toString());
      await connection.close();
    });
  }, 60_000);

  test('node:dgram — two nodes find each other over mDNS multicast', async () => {
    if (!(await multicastAvailable())) {
      console.warn('skipping the mDNS test: this host cannot do UDP multicast');
      return;
    }

    // mDNS shares UDP 5353 with every other responder on the machine (Spotify,
    // AirPlay, the OS itself) and an announcement is occasionally lost to that
    // contention. Retrying with a fresh pair distinguishes "Bun cannot do
    // multicast" — which fails every attempt — from one dropped datagram.
    const ATTEMPTS = 3;
    let discovered = false;

    for (let attempt = 1; attempt <= ATTEMPTS && !discovered; attempt += 1) {
      discovered = await withNodes(2, uniqueTag(), async ([a, b]) => {
        const found = await new Promise<any>((resolve) => {
          const timer = setTimeout(() => resolve(null), 15_000);
          a.addEventListener('peer:discovery', (event: any) => {
            if (event.detail.id.toString() !== b.peerId.toString()) return;
            clearTimeout(timer);
            resolve(event.detail);
          });
        });

        if (found === null) {
          console.warn(`mDNS attempt ${attempt}/${ATTEMPTS} saw no announcement; retrying`);
          return false;
        }

        expect(found.id.toString()).toBe(b.peerId.toString());

        // Discovery is only useful if the advertised addresses are dialable.
        const connection = await a.dial(b.peerId);
        expect(connection.status).toBe('open');
        await connection.close();
        return true;
      });
    }

    expect(discovered).toBe(true);
  }, 120_000);

  describe('node:crypto — chacha20-poly1305 over the 1200-byte threshold', () => {
    // @chainsafe/libp2p-noise splits ChaCha20-Poly1305 by payload size
    // (dist/src/crypto/index.js): under 1200 bytes it uses a WASM backend, at
    // or over it calls node:crypto's createCipheriv('chacha20-poly1305') —
    // which Bun does not implement. That split is why the failure hides: the
    // handshake, identify and ping are all small and succeed, so a node looks
    // healthy right up until the first real prompt or completion, which dies
    // mid-stream and surfaces only as a dropped connection and a reconnect.
    const BIG = 64 * 1024;

    test('pureJsCrypto round-trips a payload over the threshold', () => {
      const key = new Uint8Array(32).fill(7);
      const nonce = new Uint8Array(12).fill(3);
      const ad = new Uint8Array(0);
      const plaintext = new Uint8Array(BIG).fill(0x5a);

      const sealed = pureJsCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key);
      const opened = pureJsCrypto.chaCha20Poly1305Decrypt(sealed, nonce, ad, key);

      expect(opened.subarray()).toEqual(plaintext);
    });

    test('two nodes exchange a payload over the threshold end to end', async () => {
      const PROTOCOL = '/diiisco-test/chacha/1.0.0';
      const payload = new Uint8Array(BIG);
      // Random, not a constant fill: a cipher that silently no-ops would still
      // pass a comparison of two identical constant buffers.
      crypto.getRandomValues(payload);

      await withNodes(2, uniqueTag(), async ([a, b]) => {
        const received = new Promise<Uint8Array>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no payload arrived within 30s')), 30_000);
          a.handle(PROTOCOL, (stream: Stream, _connection: Connection) => {
            lpStream(stream)
              .read({ maxDataLength: BIG * 2 })
              .then((data: any) => {
                clearTimeout(timer);
                resolve(data.subarray());
              })
              .catch((err: Error) => {
                clearTimeout(timer);
                reject(err);
              });
          }).catch(reject);
        });

        await b.dial(a.getMultiaddrs()[0]);
        const stream = await b.dialProtocol(a.peerId, PROTOCOL);
        const lp = lpStream(stream);
        await lp.write(payload);
        // Mirrors sendDirect() in src/messaging/directMessaging.ts. `write()`
        // resolving does not mean the bytes are on the wire — a payload this
        // size sits in the muxer until the stream is closed, so without this
        // the reader waits forever.
        await lp.unwrap().close();

        // Byte-for-byte: a working cipher is not enough, it has to be the
        // right plaintext out the far end.
        expect(await received).toEqual(payload);
      }, noise({ crypto: pureJsCrypto }));
    }, 60_000);
  });
});
