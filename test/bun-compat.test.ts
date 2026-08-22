/**
 * The Bun compatibility risks the spec calls release-blocking (§5.3).
 *
 * Bun's Node-API surface is broad but not identical to Node 22, and these are
 * the places the dependency tree actually depends on the difference:
 *
 *   1. `node:net` socket behaviour used by `@libp2p/tcp` — both that a dial
 *      works at all, and that an *aborted* dial does not take the process down
 *      (see `src/libp2p/bunSafeTcp.ts` and `src/utils/processGuards.ts`)
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
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection, Stream } from '@libp2p/interface';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSafeTcp } from '../src/libp2p/bunSafeTcp';
import { multicastAvailable, repoRoot, sleep } from './helpers';

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

  describe('node:net — an aborted dial must not kill the process', () => {
    // The failure this guards against, in order:
    //
    //   1. @libp2p/tcp builds its socket config by spreading the whole dial
    //      options object, so `options.signal` reaches `net.connect()`.
    //   2. On abort, Bun destroys the socket with `signal.reason` verbatim — a
    //      DOMException — and defers the 'error' event to the next tick. (Node
    //      wraps the reason in a real AbortError and emits nothing, because
    //      libp2p has already destroyed the socket by then.)
    //   3. libp2p's own abort handler runs first and calls `done()`, which
    //      removes the socket's 'error' listener.
    //   4. The event lands on an emitter with no listener, and since a
    //      DOMException is not a JSC Error, node:events raises
    //      ERR_UNHANDLED_ERROR rather than rethrowing the abort — uncatchable
    //      from the dial's own try/catch, and fatal.
    //
    // Every aborted dial is a candidate: the 30s keep-alive ping, the
    // dialProtocol timeout in direct messaging, kad-dht queries, and the
    // @libp2p/random-walk teardown AutoNAT triggers whenever it stops walking.

    /** TEST-NET-1 — reserved and never routed, so the connect stays pending until we abort it. */
    const UNROUTABLE = '/ip4/192.0.2.1/tcp/4242';

    /** The bare minimum ComponentLogger @libp2p/tcp asks its components for. */
    function stubLogger(): any {
      const make = (): any => {
        const log: any = () => {};
        log.error = () => {};
        log.trace = () => {};
        log.enabled = false;
        log.newScope = () => make();
        return log;
      };
      return { forComponent: () => make() };
    }

    test('bunSafeTcp keeps the signal out of net.connect(), so the abort is survivable', async () => {
      const transport = bunSafeTcp()({ logger: stubLogger() }) as any;
      const controller = new AbortController();

      const dial = transport._connect(multiaddr(UNROUTABLE), {
        signal: controller.signal,
        upgrader: {} as any,
      });

      setTimeout(() => controller.abort(), 50);
      await expect(dial).rejects.toThrow();

      // The unhandled 'error' event would arrive a tick after the destroy. If
      // the shielding has regressed, this whole test process is gone before the
      // sleep resolves and the suite reports a crash rather than a failure.
      await sleep(500);
      expect(transport._connect).toBeInstanceOf(Function);
    }, 15_000);

    test('installProcessGuards() survives the raw failure that bunSafeTcp avoids', () => {
      // Driven out-of-process because the thing under test is whether the
      // *process* lives: an assertion inside this one could never run if it did
      // not. Both variants reproduce @libp2p/tcp's exact sequence by hand, so
      // the guard is exercised even if the transport shielding is ever removed.
      const script = (guarded: boolean) => `
import net from 'node:net';
${guarded ? `import { installProcessGuards } from ${JSON.stringify(join(repoRoot, 'src/utils/processGuards.ts'))};\ninstallProcessGuards();` : ''}
const controller = new AbortController();
const socket = net.connect({ host: '192.0.2.1', port: 4242, signal: controller.signal });
const onError = () => {};
socket.on('error', onError);
controller.signal.addEventListener('abort', () => {
  socket.removeListener('error', onError);   // @libp2p/tcp's done()
  socket.destroy();                          // .catch(() => rawSocket?.destroy())
});
setTimeout(() => controller.abort(), 50);
setTimeout(() => { console.log('survived'); process.exit(0); }, 600);
`;

      const dir = mkdtempSync(join(tmpdir(), 'diiisco-abort-'));
      try {
        const run = (guarded: boolean) => {
          const file = join(dir, `${guarded ? 'guarded' : 'bare'}.ts`);
          writeFileSync(file, script(guarded), 'utf8');
          return spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 });
        };

        const guarded = run(true);
        expect(guarded.status).toBe(0);
        expect(guarded.stdout).toContain('survived');

        // Not asserted as a failure: this documents the runtime bug the guard
        // exists for, and a Bun release that fixes it should not turn CI red —
        // it should tell us the workaround can go.
        const bare = run(false);
        if (bare.status === 0) {
          console.warn('note: Bun no longer crashes on an aborted dial — bunSafeTcp/processGuards may be removable');
        } else {
          expect(bare.stderr).toContain('ERR_UNHANDLED_ERROR');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  });

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
