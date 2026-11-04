/**
 * Reconnect and bootstrap dialling (`src/libp2p/reconnection.ts`).
 *
 * libp2p 3.x `dial()` accepts a PeerId or Multiaddr and throws on a plain
 * string, so every reconnect used to fail. These tests run against a stub node
 * that enforces the same rule.
 */
import { describe, expect, test } from 'bun:test';
import { isMultiaddr } from '@multiformats/multiaddr';
import { isPeerId } from '@libp2p/interface';
import { toDialTarget } from '../src/libp2p/dialTarget';
import { attemptReconnect, reconnectToBootstrap, startConnectionHealthCheck, stopConnectionHealthCheck } from '../src/libp2p/reconnection';

const PEER = 'QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN';
const ADDR = `/ip4/127.0.0.1/tcp/4242/p2p/${PEER}`;

/** A node that, like libp2p, rejects anything that is not a PeerId or Multiaddr. */
function strictNode(options: { failDials?: boolean } = {}) {
  const dialled: unknown[] = [];
  const node = {
    dial: async (target: unknown) => {
      dialled.push(target);
      if (!isPeerId(target) && !isMultiaddr(target)) throw new TypeError('multiaddrs[0].getComponents is not a function');
      if (options.failDials) throw new Error('refused');
    },
    getConnections: () => [] as any[],
  };
  return { node, dialled };
}

function deps(node: any, overrides: Record<string, unknown> = {}): any {
  return {
    reconnectAttempts: new Map(),
    RECONNECT_COOLDOWN: 300000,
    MAX_RECONNECT_ATTEMPTS: 5,
    RECONNECT_DELAY: 5000,
    attemptReconnect: async () => {},
    node,
    knownPeers: new Map(),
    MIN_CONNECTIONS: 2,
    BOOTSTRAP_RETRY_INTERVAL: 120000,
    lastBootstrapAttempt: 0,
    bootstrapAddresses: [ADDR],
    lastConnectionCount: -1,
    ...overrides,
  };
}

const noStrings = (dialled: unknown[]) => expect(dialled.some((d) => typeof d === 'string')).toBe(false);

describe('toDialTarget', () => {
  test('a multiaddr string becomes a Multiaddr', () => {
    expect(isMultiaddr(toDialTarget(ADDR))).toBe(true);
  });

  test('a peer id string becomes a PeerId', () => {
    expect(isPeerId(toDialTarget(PEER))).toBe(true);
  });

  test('a malformed value is null rather than a throw', () => {
    expect(toDialTarget('/not/a/multiaddr')).toBeNull();
    expect(toDialTarget('not a peer id')).toBeNull();
  });
});

describe('reconnect dials', () => {
  test('bootstrap redial converts the address and connects', async () => {
    const { node, dialled } = strictNode();
    const count = await reconnectToBootstrap(deps(node), 0);
    expect(count).toBe(1);
    expect(dialled).toHaveLength(1);
    noStrings(dialled);
  });

  test('a dropped peer is redialled through its stored multiaddr', async () => {
    const { node, dialled } = strictNode();
    const d = deps(node, { knownPeers: new Map([[PEER, { lastSeen: Date.now(), multiaddrs: [ADDR] }]]) });
    await attemptReconnect(PEER, d);
    expect(dialled).toHaveLength(1);
    noStrings(dialled);
  });

  test('a dropped peer with no stored address is redialled by peer id', async () => {
    const { node, dialled } = strictNode();
    await attemptReconnect(PEER, deps(node));
    expect(dialled).toHaveLength(1);
    expect(isPeerId(dialled[0])).toBe(true);
  });

  test('the health check redials with a real target when the node is offline', async () => {
    const { node, dialled } = strictNode();
    const d = deps(node, { knownPeers: new Map([[PEER, { lastSeen: Date.now(), multiaddrs: [] }]]) });
    const realSetInterval = globalThis.setInterval;
    let tick: (() => Promise<void>) | undefined;
    (globalThis as any).setInterval = (fn: () => Promise<void>) => { tick = fn; return 0; };
    try {
      startConnectionHealthCheck(d);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    // Zero connections: the bootstrap path settles for 5 s, so cap the wait.
    d.bootstrapAddresses = [];
    await tick!();
    stopConnectionHealthCheck();
    expect(dialled.length).toBeGreaterThan(0);
    noStrings(dialled);
  });

  test('a malformed stored address is skipped, not fatal', async () => {
    const { node, dialled } = strictNode();
    const d = deps(node, { knownPeers: new Map([[PEER, { lastSeen: Date.now(), multiaddrs: ['garbage', ADDR] }]]) });
    await attemptReconnect(PEER, d);
    expect(dialled).toHaveLength(1);
    noStrings(dialled);
  });
});
