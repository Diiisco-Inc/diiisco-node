/**
 * A `local.enabled` node must never hold a connection to a public-network node
 * (src/libp2p/networkGuard.ts). The decision logic is pure, so it is tested
 * here without a libp2p node.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import environment from '../src/environment/runtime';
import { getNetworkId, PUBLIC_NETWORK_ID } from '../src/utils/topic';
import { PUBLIC_BOOTSTRAP_SERVERS } from '../src/environment/defaults';
import { lookupBootstrapServers } from '../src/libp2p/node';
import { NetworkGuard, bootstrapPeerIds, judgePeer, markerProtocol } from '../src/libp2p/networkGuard';

const original = { local: environment.local, servers: environment.libp2pBootstrapServers };
afterEach(() => {
  environment.local = original.local;
  environment.libp2pBootstrapServers = original.servers;
});

describe('getNetworkId', () => {
  test('is public by default', () => {
    environment.local = { enabled: false };
    expect(getNetworkId()).toBe(PUBLIC_NETWORK_ID);
  });

  test('ignores a stray privateTopic when local mode is off', () => {
    environment.local = { enabled: false, privateTopic: 'org/models/1' };
    expect(getNetworkId()).toBe(PUBLIC_NETWORK_ID);
  });

  test('is derived from the privateTopic in local mode', () => {
    environment.local = { enabled: true, privateTopic: 'org/models/1' };
    const id = getNetworkId();
    expect(id).toMatch(/^local-[0-9a-f]{16}$/);
    environment.local = { enabled: true, privateTopic: 'org/models/2' };
    expect(getNetworkId()).not.toBe(id);
  });
});

describe('lookupBootstrapServers', () => {
  const custom = '/ip4/192.168.1.5/tcp/4242/p2p/12D3KooWExample';

  test('local mode drops the public servers and keeps the operator\'s own', async () => {
    environment.local = { enabled: true, privateTopic: 't' };
    environment.libp2pBootstrapServers = [...PUBLIC_BOOTSTRAP_SERVERS, custom];
    expect(await lookupBootstrapServers()).toEqual([custom]);
  });

  test('local mode with only the defaults has no bootstrap servers', async () => {
    environment.local = { enabled: true, privateTopic: 't' };
    environment.libp2pBootstrapServers = [...PUBLIC_BOOTSTRAP_SERVERS];
    expect(await lookupBootstrapServers()).toEqual([]);
  });

  test('public mode leaves a configured list alone', async () => {
    environment.local = { enabled: false };
    environment.libp2pBootstrapServers = [custom];
    expect(await lookupBootstrapServers()).toEqual([custom]);
  });
});

describe('judgePeer', () => {
  const privateId = 'local-0123456789abcdef';

  test('a private node keeps peers with its marker', () => {
    expect(judgePeer(privateId, [markerProtocol(privateId)])).toBe('allow');
  });

  test('a private node refuses a public peer', () => {
    expect(judgePeer(privateId, [markerProtocol(PUBLIC_NETWORK_ID), '/meshsub/1.1.0'])).toBe('deny');
  });

  test('a private node refuses a peer with no marker (strict)', () => {
    expect(judgePeer(privateId, ['/meshsub/1.1.0'])).toBe('deny');
  });

  test('a private node refuses a different private cluster', () => {
    expect(judgePeer(privateId, [markerProtocol('local-ffffffffffffffff')])).toBe('deny');
  });

  test('a public node keeps public peers and peers that predate the marker', () => {
    expect(judgePeer(PUBLIC_NETWORK_ID, [markerProtocol(PUBLIC_NETWORK_ID)])).toBe('allow');
    expect(judgePeer(PUBLIC_NETWORK_ID, ['/meshsub/1.1.0'])).toBe('allow');
  });

  test('a public node refuses a private peer', () => {
    expect(judgePeer(PUBLIC_NETWORK_ID, [markerProtocol(privateId)])).toBe('deny');
  });
});

describe('NetworkGuard', () => {
  const id = 'local-0123456789abcdef';

  test('remembers a refusal until the TTL passes', () => {
    const guard = new NetworkGuard(id, [], 1000);
    expect(guard.evaluate('peerA', ['/meshsub/1.1.0'], 0)).toBe('deny');
    expect(guard.isDenied('peerA', 500)).toBe(true);
    expect(guard.isDenied('peerA', 1001)).toBe(false);
  });

  test('a peer that now passes is no longer denied', () => {
    const guard = new NetworkGuard(id, [], 1000);
    guard.evaluate('peerA', [], 0);
    expect(guard.evaluate('peerA', [markerProtocol(id)], 10)).toBe('allow');
    expect(guard.isDenied('peerA', 20)).toBe(false);
  });

  test('configured bootstrap peers are exempt', () => {
    const guard = new NetworkGuard(id, ['relayPeer']);
    expect(guard.evaluate('relayPeer', [], 0)).toBe('allow');
    expect(guard.isDenied('relayPeer')).toBe(false);
  });

  test('the gater refuses dials to and connections from a denied peer', () => {
    const guard = new NetworkGuard(id);
    guard.evaluate('peerA', [], Date.now());
    const gater = guard.gater();
    expect(gater.denyDialPeer({ toString: () => 'peerA' })).toBe(true);
    expect(gater.denyInboundUpgradedConnection({ toString: () => 'peerA' })).toBe(true);
    expect(gater.denyDialPeer({ toString: () => 'peerB' })).toBe(false);
  });
});

describe('bootstrapPeerIds', () => {
  test('extracts peer ids and skips addresses without one', () => {
    expect(bootstrapPeerIds(['/dns4/x.example/tcp/4242/p2p/12D3KooWAbc', '/ip4/1.2.3.4/tcp/1'])).toEqual(['12D3KooWAbc']);
  });
});
