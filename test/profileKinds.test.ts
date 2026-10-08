/**
 * The kind of each model, as published on the node's profile
 * (`/node.json`, and the `node-profile` reply) for the status page's
 * "Decision" / "Embedding" chips.
 *
 * Run against the source with a stubbed node and wallet: the profile builder is
 * a pure function of those and the availability monitor's answers.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { configureEnvironment } from '../src/environment/runtime';
import type { ModelKind } from '../src/types/models';

beforeAll(() => {
  configureEnvironment({ local: { enabled: true, privateTopic: 'profile-kinds-test/models/1.0.0' } });
});

const node = {
  peerId: { toString: () => '12D3KooWTestPeer' },
  getMultiaddrs: () => [],
  getConnections: () => [],
  services: { pubsub: { getSubscribers: () => [] } },
};
const algo = { nfdVerified: false, nfdAddr: null, account: { addr: { toString: () => 'WALLET' } } };

const KINDS: Record<string, ModelKind> = {
  'tev1:0.8b': 'decision',
  'embeddinggemma:latest': 'embedding',
  'gemma4:12b': 'chat',
};

describe('buildOwnProfile — model kinds', () => {
  test('publishes decision and embedding kinds, and leaves chat models untouched', () => {
    const { buildOwnProfile } = require('../src/utils/nodeProfile');

    const profile = buildOwnProfile(node, algo, Object.keys(KINDS), (id: string) => KINDS[id] ?? 'chat');
    const byId = Object.fromEntries(profile.stats.models.map((m: any) => [m.id, m]));

    expect(byId['tev1:0.8b'].kind).toBe('decision');
    expect(byId['embeddinggemma:latest'].kind).toBe('embedding');
    // No `kind` key at all for chat: an ordinary node's profile is unchanged.
    expect('kind' in byId['gemma4:12b']).toBe(false);
    expect(byId['gemma4:12b'].pricePerInputToken1M).toBeDefined();
  });

  test('without a kind lookup every model is a chat model with no kind published', () => {
    const { buildOwnProfile } = require('../src/utils/nodeProfile');

    const profile = buildOwnProfile(node, algo, ['gemma4:12b', 'tev1:0.8b']);

    expect(profile.stats.models.every((m: any) => !('kind' in m))).toBe(true);
  });

  test('a node that withholds its stats publishes no models, so no kinds either', () => {
    configureEnvironment({ node: { publicStats: false } });
    const { buildOwnProfile } = require('../src/utils/nodeProfile');

    const profile = buildOwnProfile(node, algo, Object.keys(KINDS), (id: string) => KINDS[id]);

    expect(profile.stats).toBeUndefined();
    configureEnvironment({ node: { publicStats: true } });
  });
});
