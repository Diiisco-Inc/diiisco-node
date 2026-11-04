/**
 * `diiisco peers` and `diiisco peers --reconnect`: the peer report, the forced
 * maintenance pass behind it, and the control-channel actions that carry them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { isMultiaddr } from '@multiformats/multiaddr';
import { isPeerId } from '@libp2p/interface';
import { buildPeerReport } from '../src/libp2p/peerReport';
import { FORCE_MAX_DIALS_PER_PASS, runMaintenancePass } from '../src/libp2p/reconnection';
import { generateControlToken, requestPeers, requestReconnect, startControlServer, type ControlServer } from '../src/cli/control';

const ids = [
  'QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  'QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  'QmbLHAnMoJPWSCR5Zhtx6BHJX9MiJWBurPdUBHxqjSThvS',
  'QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSupNKC',
  'QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp',
  'QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
];
const NOW = 1_800_000_000_000;
const DIRECT = '/ip4/10.0.0.2/tcp/4242';
const RELAYED = `/dns4/lon.diiisco.com/tcp/4242/p2p/${ids[0]}/p2p-circuit`;

const connection = (id: string, addr: string) => ({ remotePeer: { toString: () => id }, remoteAddr: { toString: () => addr } });

describe('buildPeerReport', () => {
  test('counts direct and relayed-only peers and flags the bootstrap servers', () => {
    const node: any = {
      dial: async () => {},
      getConnections: () => [connection(ids[0], DIRECT), connection(ids[1], RELAYED), connection(ids[2], DIRECT)],
    };
    const report = buildPeerReport(node, { bootstrapPeerIds: [ids[0], ids[3]], target: 8, known: 5 });
    expect(report).toMatchObject({ connected: 3, direct: 2, relayedOnly: 1, bootstrapConnected: 1, bootstrapTotal: 2, target: 8, known: 5 });
    expect(report.peers[0]).toMatchObject({ peerId: ids[0], bootstrap: true });
    expect(report.peers.find((p) => p.peerId === ids[1])).toMatchObject({ direct: false, relayedOnly: true });
  });

  test('a peer with both a relayed and a direct connection is direct, and counted once', () => {
    const node: any = {
      dial: async () => {},
      getConnections: () => [connection(ids[1], RELAYED), connection(ids[1], DIRECT)],
    };
    const report = buildPeerReport(node, { bootstrapPeerIds: [], target: 8, known: 0 });
    expect(report.connected).toBe(1);
    expect(report.peers[0]).toMatchObject({ direct: true, relayedOnly: false });
  });

  test('no connections is an empty report', () => {
    const node: any = { dial: async () => {}, getConnections: () => [] };
    expect(buildPeerReport(node, { bootstrapPeerIds: [], target: 8, known: 0 }).peers).toEqual([]);
  });
});

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
    knownPeers: new Map(known.map((id) => [id, { lastSeen: NOW - 1000, multiaddrs: [`/ip4/10.0.0.9/tcp/4242/p2p/${id}`] }])),
    MIN_CONNECTIONS: 2,
    TARGET_CONNECTIONS: 2,
    BOOTSTRAP_RETRY_INTERVAL: 120000,
    lastBootstrapAttempt: NOW,
    lastDiscovery: NOW,
    bootstrapAddresses: [],
    lastConnectionCount: -1,
    ...overrides,
  };
}

describe('runMaintenancePass with force', () => {
  test('a routine pass leaves a node at its target alone, a forced one redials', async () => {
    const connected = [ids[0], ids[1]];
    const routine = stubNode(connected);
    await runMaintenancePass(deps(routine.node, [...connected, ids[2]]), NOW);
    expect(routine.dialled).toHaveLength(0);

    const forced = stubNode(connected);
    await runMaintenancePass(deps(forced.node, [...connected, ids[2]]), NOW, { force: true });
    expect(forced.dialled).toHaveLength(1);
  });

  test('ignores a peer\'s backoff', async () => {
    const { node, dialled } = stubNode([ids[0]]);
    const d = deps(node, [ids[1]], { TARGET_CONNECTIONS: 8 });
    d.reconnectAttempts.set(ids[1], { count: 6, lastAttempt: NOW - 1000 });

    await runMaintenancePass(d, NOW);
    expect(dialled).toHaveLength(0);

    await runMaintenancePass(d, NOW, { force: true });
    expect(dialled).toHaveLength(1);
  });

  test('is allowed more redials than a routine pass', async () => {
    const known = [ids[1], ids[2], ids[3], ids[4]];
    const routine = stubNode([ids[0]]);
    await runMaintenancePass(deps(routine.node, known, { TARGET_CONNECTIONS: 8, MAX_DIALS_PER_PASS: 1 }), NOW);
    expect(routine.dialled).toHaveLength(1);

    const forced = stubNode([ids[0]]);
    await runMaintenancePass(deps(forced.node, known, { TARGET_CONNECTIONS: 8, MAX_DIALS_PER_PASS: 1 }), NOW, { force: true });
    expect(forced.dialled).toHaveLength(4);
    expect(FORCE_MAX_DIALS_PER_PASS).toBeGreaterThanOrEqual(4);
  });

  test('redials a missing bootstrap server and walks the DHT even when both were just done', async () => {
    const { node, dialled } = stubNode([ids[0]]);
    let walked = 0;
    const withRouting = {
      ...node,
      peerId: { toString: () => 'self', toMultihash: () => ({ bytes: new Uint8Array([1]) }) },
      peerRouting: { getClosestPeers: async function* () { walked += 1; } },
    };
    const d = deps(withRouting, [], { bootstrapAddresses: [`/ip4/10.0.0.3/tcp/4242/p2p/${ids[3]}`], TARGET_CONNECTIONS: 1 });

    await runMaintenancePass(d, NOW);
    expect(dialled).toHaveLength(0);
    expect(walked).toBe(0);

    await runMaintenancePass(d, NOW, { force: true });
    expect(dialled).toHaveLength(1);
    expect(walked).toBe(1);
  });
});

describe('control channel: peers and reconnect', () => {
  let server: ControlServer | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  const report = { connected: 2, direct: 2, relayedOnly: 0, bootstrapConnected: 1, bootstrapTotal: 3, target: 8, known: 4, peers: [] };

  test('peers returns the node\'s report', async () => {
    const token = generateControlToken();
    server = await startControlServer({ token, onShutdown: () => {}, onPeers: () => report });
    const answer = await requestPeers(server.port, token);
    expect(answer.ok).toBe(true);
    expect(answer.value).toEqual(report);
  });

  test('peers says the node is still starting while there is no report', async () => {
    const token = generateControlToken();
    server = await startControlServer({ token, onShutdown: () => {}, onPeers: () => null });
    const answer = await requestPeers(server.port, token);
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('still starting');
  });

  test('reconnect waits for the pass and returns what it did', async () => {
    const token = generateControlToken();
    let ran = 0;
    server = await startControlServer({
      token,
      onShutdown: () => {},
      onReconnect: async () => { ran += 1; await new Promise((r) => setTimeout(r, 50)); return { before: 1, after: 5, report }; },
    });
    const answer = await requestReconnect(server.port, token);
    expect(answer.ok).toBe(true);
    expect(answer.value).toMatchObject({ before: 1, after: 5 });
    expect(ran).toBe(1);
  });

  test('a failing reconnect reports its reason', async () => {
    const token = generateControlToken();
    server = await startControlServer({ token, onShutdown: () => {}, onReconnect: async () => { throw new Error('the node is shutting down'); } });
    const answer = await requestReconnect(server.port, token);
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe('the node is shutting down');
  });

  test('reconnect is refused when the node does not support it', async () => {
    const token = generateControlToken();
    server = await startControlServer({ token, onShutdown: () => {} });
    const answer = await requestReconnect(server.port, token);
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('does not support');
  });

  test('neither action works without the token, and neither runs', async () => {
    const token = generateControlToken();
    let ran = 0;
    server = await startControlServer({ token, onShutdown: () => {}, onPeers: () => { ran += 1; return report; }, onReconnect: async () => { ran += 1; return {}; } });
    expect((await requestPeers(server.port, 'wrong')).ok).toBe(false);
    expect((await requestReconnect(server.port, 'wrong')).ok).toBe(false);
    expect(ran).toBe(0);
  });
});
