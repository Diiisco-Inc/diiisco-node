/**
 * Keeping connections up (`src/libp2p/reconnection.ts`).
 *
 * The node used to redial known peers only below `MIN_CONNECTIONS` (2), which
 * its three bootstrap connections always satisfied, and gave up on a dropped
 * peer after five tries. Everything runs against a stub node.
 */
import { describe, expect, test } from 'bun:test';
import { isMultiaddr } from '@multiformats/multiaddr';
import { isPeerId } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  MAX_RECONNECT_DELAY,
  reconnectDelay,
  rememberPeerAddresses,
  runMaintenancePass,
  scheduleReconnect,
  withPeerId,
} from '../src/libp2p/reconnection';
import { NetworkGuard } from '../src/libp2p/networkGuard';

const ids = [
  'QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  'QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  'QmbLHAnMoJPWSCR5Zhtx6BHJX9MiJWBurPdUBHxqjSThvS',
  'QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSupNKC',
  'QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp',
  'QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
];
const addr = (id: string) => `/ip4/10.0.0.${ids.indexOf(id) + 2}/tcp/4242/p2p/${id}`;
const NOW = 1_800_000_000_000;

function stubNode(connected: string[]) {
  const dialled: unknown[] = [];
  const node = {
    dial: async (target: unknown) => {
      dialled.push(target);
      if (!isPeerId(target) && !isMultiaddr(target)) throw new TypeError('not dialable');
    },
    getConnections: () => connected.map((id) => ({ remotePeer: { toString: () => id } })),
  };
  return { node, dialled };
}

function deps(node: any, known: string[], overrides: Record<string, unknown> = {}): any {
  return {
    reconnectAttempts: new Map(),
    RECONNECT_COOLDOWN: 300000,
    RECONNECT_DELAY: 5000,
    attemptReconnect: async () => {},
    node,
    knownPeers: new Map(known.map((id) => [id, { lastSeen: NOW - 1000, multiaddrs: [addr(id)] }])),
    MIN_CONNECTIONS: 2,
    TARGET_CONNECTIONS: 8,
    BOOTSTRAP_RETRY_INTERVAL: 120000,
    lastBootstrapAttempt: NOW, // not due
    lastDiscovery: NOW,        // not due
    bootstrapAddresses: [],
    lastConnectionCount: -1,
    ...overrides,
  };
}

describe('runMaintenancePass', () => {
  test('redials known peers even though the minimum is met', async () => {
    // Three bootstrap peers connected (the real case), two other peers lost.
    const { node, dialled } = stubNode([ids[0], ids[1], ids[2]]);
    await runMaintenancePass(deps(node, [ids[0], ids[1], ids[2], ids[3], ids[4]]), NOW);
    expect(dialled).toHaveLength(2);
    expect(dialled.every((d) => isMultiaddr(d))).toBe(true);
  });

  test('does nothing when the target is already met', async () => {
    const connected = ids.slice(0, 5);
    const { node, dialled } = stubNode(connected);
    await runMaintenancePass(deps(node, [...connected, ids[5]], { TARGET_CONNECTIONS: 5 }), NOW);
    expect(dialled).toHaveLength(0);
  });

  test('caps the redials started in one pass', async () => {
    const { node, dialled } = stubNode([ids[0]]);
    await runMaintenancePass(deps(node, ids.slice(1), { MAX_DIALS_PER_PASS: 2 }), NOW);
    expect(dialled).toHaveLength(2);
  });

  test('a peer that failed recently waits out its backoff, then is tried again', async () => {
    const { node, dialled } = stubNode([ids[0]]);
    const d = deps(node, [ids[1]]);
    d.reconnectAttempts.set(ids[1], { count: 2, lastAttempt: NOW - 1000 }); // wait is 20 s

    await runMaintenancePass(d, NOW);
    expect(dialled).toHaveLength(0);

    await runMaintenancePass(d, NOW + 25000);
    expect(dialled).toHaveLength(1);
  });

  test('a failed redial counts against the peer and a success clears it', async () => {
    const { node } = stubNode([ids[0]]);
    const failing = { ...node, dial: async () => { throw new Error('refused'); } };
    const d = deps(failing, [ids[1]]);
    await runMaintenancePass(d, NOW);
    expect(d.reconnectAttempts.get(ids[1])?.count).toBe(1);

    const working = deps(node, [ids[1]]);
    working.reconnectAttempts.set(ids[1], { count: 3, lastAttempt: 0 });
    await runMaintenancePass(working, NOW);
    expect(working.reconnectAttempts.has(ids[1])).toBe(false);
  });

  test('a peer not seen for a day is forgotten, not redialled', async () => {
    const { node, dialled } = stubNode([ids[0]]);
    const d = deps(node, [ids[1]]);
    d.knownPeers.get(ids[1]).lastSeen = NOW - 25 * 60 * 60 * 1000;
    await runMaintenancePass(d, NOW);
    expect(dialled).toHaveLength(0);
    expect(d.knownPeers.has(ids[1])).toBe(false);
  });

  test('redials a bootstrap server that dropped while others are up', async () => {
    const { node, dialled } = stubNode([ids[0], ids[1], ids[2]]);
    const d = deps(node, [], {
      bootstrapAddresses: [addr(ids[0]), addr(ids[3])],
      lastBootstrapAttempt: 0,
    });
    await runMaintenancePass(d, NOW);
    expect(dialled).toHaveLength(1); // only the missing one
    expect(d.lastBootstrapAttempt).toBe(NOW);
  });

  test('walks the DHT for new peers when below target and the interval has passed', async () => {
    const { node, dialled } = stubNode([ids[0]]);
    const self = { toString: () => 'self', toMultihash: () => ({ bytes: new Uint8Array([1]) }) };
    const found = { id: peerIdFromString(ids[5]), multiaddrs: [] as any[] };
    const withRouting = {
      ...node,
      peerId: self,
      peerRouting: { getClosestPeers: async function* () { yield found; } },
    };
    const d = deps(withRouting, [], { lastDiscovery: 0 });
    await runMaintenancePass(d, NOW);
    expect(dialled).toHaveLength(1);
    expect(d.lastDiscovery).toBe(NOW);
    expect(d.knownPeers.has(ids[5])).toBe(true);
  });
});

describe('scheduleReconnect', () => {
  /** Run scheduleReconnect with timers captured instead of started. */
  async function schedule(peerId: string, d: any) {
    const realSetTimeout = globalThis.setTimeout;
    const timers: { fn: () => Promise<void>; ms: number }[] = [];
    (globalThis as any).setTimeout = (fn: () => Promise<void>, ms: number) => {
      timers.push({ fn, ms });
      return { unref() {} };
    };
    try {
      await scheduleReconnect(peerId, d);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    return timers;
  }

  test('keeps going past five attempts, slowing to the cap', async () => {
    const d = deps(stubNode([]).node, [ids[1]]);
    d.knownPeers.get(ids[1]).lastSeen = Date.now();
    d.reconnectAttempts.set(ids[1], { count: 12, lastAttempt: Date.now() });
    const timers = await schedule(ids[1], d);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(MAX_RECONNECT_DELAY);
    await timers[0].fn();
  });

  test('a second disconnect event does not start a second timer chain', async () => {
    const d = deps(stubNode([]).node, [ids[2]]);
    d.knownPeers.get(ids[2]).lastSeen = Date.now();
    const first = await schedule(ids[2], d);
    const second = await schedule(ids[2], d);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    await first[0].fn();
  });
});

describe('helpers', () => {
  test('backoff doubles from the base and is capped', () => {
    expect([0, 1, 2, 3].map((n) => reconnectDelay(n, 5000))).toEqual([5000, 10000, 20000, 40000]);
    expect(reconnectDelay(30, 5000)).toBe(MAX_RECONNECT_DELAY);
  });

  test('withPeerId appends the peer id once', () => {
    const base = '/ip4/1.2.3.4/tcp/4242';
    expect(withPeerId(base, ids[0])).toBe(`${base}/p2p/${ids[0]}`);
    expect(withPeerId(`${base}/p2p/${ids[0]}`, ids[0])).toBe(`${base}/p2p/${ids[0]}`);
  });

  test('remembered addresses put direct ones before relayed ones and carry the peer id', async () => {
    const known = new Map<string, { lastSeen: number; multiaddrs: string[] }>();
    const node: any = {
      getConnections: () => [],
      dial: async () => {},
      peerStore: {
        get: async () => ({
          addresses: [
            { multiaddr: { toString: () => `/dns4/relay.example/tcp/4242/p2p/${ids[1]}/p2p-circuit` } },
            { multiaddr: { toString: () => '/ip4/192.168.1.5/tcp/4242' } },
          ],
        }),
      },
    };
    await rememberPeerAddresses(node, known, peerIdFromString(ids[0]));
    const stored = known.get(ids[0])!.multiaddrs;
    expect(stored[0]).toBe(`/ip4/192.168.1.5/tcp/4242/p2p/${ids[0]}`);
    expect(stored[1]).toBe(`/dns4/relay.example/tcp/4242/p2p/${ids[1]}/p2p-circuit/p2p/${ids[0]}`);
  });
});

// Last: attaching a guard makes it the process-wide one that `isPeerDenied` reads.
describe('refused peers', () => {
  test('are never redialled', async () => {
    const guard = new NetworkGuard('local-test');
    await guard.attach({ handle: async () => {}, addEventListener: () => {} });
    guard.evaluate(ids[4], []); // no marker on a private network: refused

    const { node, dialled } = stubNode([ids[0]]);
    await runMaintenancePass(deps(node, [ids[4]]), NOW);
    expect(dialled).toHaveLength(0);
  });
});
