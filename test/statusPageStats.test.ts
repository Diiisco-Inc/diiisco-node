/**
 * Tags and performance figures on the status pages (plan 018): the node's own
 * profile, profiles from other nodes (self-declared, shown on a public page, so
 * only well-formed fields survive), and the cross-node spread on /models.json.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import environment, { configureEnvironment } from '../src/environment/runtime';
import { createApiServer } from '../src/api/server';
import type { ModelAvailability } from '../src/utils/modelAvailability';
import type { ModelPerformance } from '../src/types/performance';
import type { NodeProfileResponse, PubSubMessage } from '../src/types/messages';

const PERF: ModelPerformance = {
  ttftHotMs: { value: 80, samples: 5 },
  ttftColdMs: { value: 2000, samples: 1 },
  tokensPerSecond: { value: 50, samples: 9 },
  updatedAt: 1_800_000_000_000,
  coldStart: 'forced',
};

const node: any = {
  peerId: { toString: () => 'peer-self' },
  getMultiaddrs: () => [],
  getConnections: () => [],
  services: { pubsub: { getSubscribers: () => [] } },
};
const algo: any = { nfdVerified: false, nfdAddr: null, account: { addr: { toString: () => 'WALLET' } }, signObject: async () => 'sig' };

beforeAll(() => {
  configureEnvironment({ local: { enabled: true, privateTopic: 'status-stats-test/models/1.0.0' } });
});
afterAll(() => {
  if (environment.node) {
    delete environment.node.tags;
    delete environment.node.publicStats;
  }
});

describe('the node\'s own profile', () => {
  const kinds: Record<string, 'chat' | 'embedding' | 'decision'> = { gemma3: 'chat', embed: 'embedding', tev: 'decision' };
  const build = () => {
    const { buildOwnProfile } = require('../src/utils/nodeProfile');
    return buildOwnProfile(node, algo, Object.keys(kinds), (id: string) => kinds[id], (id: string) => (id in kinds ? PERF : undefined));
  };

  test('carries its tags and each chat and decision model\'s figures; embeddings get none', () => {
    environment.node = { ...environment.node, tags: ['cuda', 'nvidia-dgx-spark'], publicStats: true };
    const profile = build();
    expect(profile.tags).toEqual(['cuda', 'nvidia-dgx-spark']);
    const byId = Object.fromEntries(profile.stats.models.map((m: any) => [m.id, m]));
    expect(byId.gemma3.performance).toEqual(PERF);
    expect(byId.tev.performance).toEqual(PERF);
    expect('performance' in byId.embed).toBe(false);
  });

  test('publicStats: false keeps the tags (identity) but publishes no figures', () => {
    environment.node = { ...environment.node, tags: ['cuda'], publicStats: false };
    const profile = build();
    expect(profile.tags).toEqual(['cuda']);
    expect(profile.stats).toBeUndefined();
  });

  test('no tags configured, no tags key', () => {
    environment.node = { ...environment.node, tags: undefined, publicStats: true };
    expect('tags' in build()).toBe(false);
  });
});

describe('a profile from another node', () => {
  function processor(events: EventEmitter) {
    const { MessageProcessor } = require('../src/messaging/messageProcessor');
    const quoteEngineModule = require('../src/utils/quoteEngine');
    const signer = { ...algo, isValidAddress: () => true, verifySignature: async () => true };
    const models = { list: () => [], kindOf: () => 'chat' } as unknown as ModelAvailability;
    return new MessageProcessor(
      signer, {}, new quoteEngineModule.default({ emit: () => {} }, signer), models, events,
      { sendMessage: async () => {} }, 'peer-self', { peerStore: { merge: async () => {} } },
    );
  }

  const response = (profile: Record<string, unknown>): NodeProfileResponse => ({
    role: 'node-profile-response',
    to: 'peer-self',
    timestamp: Date.now(),
    id: 'profile-req-1',
    fromWalletAddr: 'WALLET',
    payload: { profile: { peerId: 'peer-remote', role: 'direct', online: true, network: 'local', observedAt: 'now', ...profile } as any },
    signature: 'sig',
  });

  async function received(profile: Record<string, unknown>) {
    const events = new EventEmitter();
    let got: any = null;
    events.on('node-profile-received-profile-req-1', (p) => { got = p; });
    await processor(events).process(response(profile) as PubSubMessage, 'peer-remote');
    return got;
  }

  test('keeps well-formed tags and figures', async () => {
    const got = await received({ tags: ['cuda'], stats: { models: [{ id: 'm', performance: PERF }], connectedPeers: 1 } });
    expect(got.tags).toEqual(['cuda']);
    expect(got.stats.models[0].performance).toEqual(PERF);
  });

  test('drops malformed tags and figures but keeps the rest of the profile', async () => {
    const got = await received({
      displayName: 'still shown',
      tags: ['<script>'],
      stats: { models: [{ id: 'm', performance: { ...PERF, tokensPerSecond: { value: -5, samples: 1 } } }], connectedPeers: 3 },
    });
    expect(got.displayName).toBe('still shown');
    expect(got.tags).toBeUndefined();
    expect(got.stats.models[0].id).toBe('m');
    expect(got.stats.models[0].performance).toBeUndefined();
    expect(got.stats.connectedPeers).toBe(3);
  });
});

describe('/models.json', () => {
  const PORT = 21000 + Math.floor(Math.random() * 900);
  const events = new EventEmitter();
  let server: any;
  const remoteProfiles: Record<string, any> = {};

  beforeAll(() => {
    environment.node = { ...environment.node, tags: undefined, publicStats: true };
    configureEnvironment({ api: { enabled: true, port: PORT, host: '127.0.0.1', bearerAuthentication: false, keys: [] } } as any);
    const peers = ['peer-a', 'peer-b', 'peer-c'];
    const meshNode: any = {
      ...node,
      getConnections: () => peers.map((p) => ({ remotePeer: { toString: () => p } })),
    };
    // Stands in for the mesh: answers each node-profile query with that peer's profile.
    const router: any = {
      sendMessage: async (msg: any, peerId: string) => {
        setTimeout(() => events.emit(`node-profile-received-${msg.id}`, remoteProfiles[peerId]), 5);
      },
    };
    const models = { list: () => ['gemma3'], kindOf: () => 'chat', models: () => [], isHealthy: () => true } as any;
    ({ server } = createApiServer(meshNode, events, algo, router, { enqueue: async () => {} } as any, undefined, models,
      undefined, undefined, () => 0, (id: string) => (id === 'gemma3' ? { ...PERF, tokensPerSecond: { value: 40, samples: 3 } } : undefined)));

    const profile = (peerId: string, performance: unknown) => ({
      peerId, role: 'direct', online: true, network: 'local', observedAt: 'now',
      stats: { models: [{ id: 'gemma3', performance }], connectedPeers: 1, meshReady: true, uptimeSeconds: 1, inferencesServed: 0, inferencesRequested: 0 },
    });
    remoteProfiles['peer-a'] = profile('peer-a', { ...PERF, tokensPerSecond: { value: 60, samples: 4 } });
    remoteProfiles['peer-b'] = profile('peer-b', undefined); // an older node, or one not yet measured
    // Reached the cache unchecked somehow: must not skew the spread.
    remoteProfiles['peer-c'] = profile('peer-c', { ...PERF, tokensPerSecond: { value: 1e12, samples: 1 } });
  });
  afterAll(() => server?.close());

  test('spreads each figure across the nodes that publish a valid one', async () => {
    const body = await (await fetch(`http://127.0.0.1:${PORT}/models.json`)).json();
    const gemma = body.data.find((m: any) => m.model === 'gemma3');
    expect(gemma.nodes).toBe(4);
    expect(gemma.tokensPerSecond).toEqual({ min: 40, median: 50, max: 60, nodes: 2 });
    expect(gemma.ttftHotMs).toEqual({ min: 80, median: 80, max: 80, nodes: 2 });
  });
});
