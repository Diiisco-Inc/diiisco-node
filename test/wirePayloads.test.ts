/**
 * Per-role payload shapes (review L7): a message whose payload is the wrong
 * shape for its role is dropped at the boundary, before any signature work and
 * without a handler ever seeing it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { payloadProblem } from '../src/messaging/wire';
import { configureEnvironment } from '../src/environment/runtime';

const base = (role: string, payload?: unknown, extra: Record<string, unknown> = {}): any => ({
  role, id: 'abc', timestamp: Date.now(), fromWalletAddr: 'W', signature: 's', ...(payload === undefined ? {} : { payload }), ...extra,
});

const GOOD: Record<string, any> = {
  'list-models': base('list-models'),
  'list-network': base('list-network'),
  'quote-request': base('quote-request', { model: 'm', inputTokenCount: 10, maxSpend: 0.1, max_tokens: 5 }),
  'quote-response': base('quote-response', { quote: { model: 'm' } }),
  'quote-accepted': base('quote-accepted', { model: 'm', inputs: [] }),
  'contract-created': base('contract-created', { paymentRequirements: { amount: '1' } }),
  'contract-signed': base('contract-signed', { paymentPayload: { x: 1 } }),
  'inference-response': base('inference-response', { completion: { choices: [] } }),
  'inference-failed': base('inference-failed', { model: 'm', reason: 'error' }),
  'list-models-response': base('list-models-response', { models: [] }),
  'list-network-response': base('list-network-response', { node: { peerId: 'p', walletAddr: 'W' } }),
  'node-profile': base('node-profile', { peerId: 'p' }),
  'node-profile-response': base('node-profile-response', { profile: { peerId: 'p' } }),
};

describe('payloadProblem', () => {
  test.each(Object.keys(GOOD))('%s: a well-formed message passes', (role) => {
    expect(payloadProblem(GOOD[role])).toBeNull();
  });

  test('optional fields may be absent or null', () => {
    const q = (extra: any) => base('quote-request', { model: 'm', inputTokenCount: 1, ...extra });
    expect(payloadProblem(q({}))).toBeNull();
    expect(payloadProblem(q({ maxSpend: null, max_tokens: null, kind: null }))).toBeNull();
    expect(payloadProblem(q({ kind: 'systemone' }))).toBeNull();
    expect(payloadProblem(base('contract-signed', {}))).toBeNull();
  });

  test.each(
    Object.keys(GOOD).filter((r) => !['list-models', 'list-network'].includes(r)).map((r) => [r])
  )('%s: a missing payload is refused', (role) => {
    const { payload: _drop, ...noPayload } = GOOD[role];
    expect(payloadProblem(noPayload as any)).not.toBeNull();
  });

  test.each([
    ['quote-request', { model: 5, inputTokenCount: 1 }],
    ['quote-request', { model: 'm', inputTokenCount: '1' }],
    ['quote-request', { model: 'm', inputTokenCount: -1 }],
    ['quote-request', { model: 'm', inputTokenCount: NaN }],
    ['quote-request', { model: 'm', inputTokenCount: 1, maxSpend: 'lots' }],
    ['quote-request', { model: 'm', inputTokenCount: 1, kind: 'other' }],
    ['quote-request', { model: 'x'.repeat(300), inputTokenCount: 1 }],
    ['quote-response', { quote: 'nonsense' }],
    ['quote-accepted', { model: { a: 1 } }],
    ['contract-created', { paymentRequirements: 'free' }],
    ['contract-signed', { paymentPayload: 'paid' }],
    ['inference-response', { notCompletion: 1 }],
    ['inference-failed', { model: 12 }],
    ['list-models-response', { models: 'all of them' }],
    ['list-network-response', { node: { peerId: 7 } }],
    ['node-profile', { peerId: ['p'] }],
    ['node-profile-response', { profile: { peerId: null } }],
    ['quote-request', [1, 2, 3]],
  ])('%s with %j is refused', (role, payload) => {
    expect(payloadProblem(base(role as string, payload))).not.toBeNull();
  });

  test.each([
    [{ id: undefined }], [{ id: 12 }], [{ id: '' }], [{ id: 'x'.repeat(200) }],
    [{ multiaddrs: 'not-a-list' }], [{ multiaddrs: [1, 2] }], [{ multiaddrs: Array(100).fill('/ip4/1.2.3.4') }],
  ])('a bad envelope field %j is refused', (override) => {
    expect(payloadProblem({ ...GOOD['quote-request'], ...override })).not.toBeNull();
  });

  test('an unknown role is left for process() to report', () => {
    expect(payloadProblem(base('made-up', { x: 1 }))).toBeNull();
  });
});

describe('MessageProcessor drops a malformed payload at the boundary', () => {
  beforeAll(() => {
    configureEnvironment({ local: { enabled: true, privateTopic: 'wire-payload-test/models/1.0.0' } } as any);
  });

  test('no signature check, no handler, no throw', async () => {
    let verifies = 0;
    let probes = 0;
    const algo: any = {
      account: { addr: { toString: () => 'W' } }, signObject: async () => 's', isValidAddress: () => true,
      verifySignature: async () => { verifies += 1; return true; }, nfdVerified: false,
      checkIfOptedInToAsset: async () => ({ optedIn: true, balance: 1n }),
    };
    const models: any = {
      ensureAvailable: async () => { probes += 1; return false; },
      list: () => [], models: () => [], kindOf: () => 'chat', isAvailable: () => false, invalidate: () => {},
    };
    const { MessageProcessor } = require('../src/messaging/messageProcessor');
    const quoteEngineModule = require('../src/utils/quoteEngine');
    const processor = new MessageProcessor(
      algo, { getModels: async () => [] }, new quoteEngineModule.default({ emit: () => {} }, algo), models,
      new EventEmitter(), { sendMessage: async () => {} }, 'peer-self', { peerStore: { merge: async () => {} } },
    );

    const bad = base('quote-request', { model: { not: 'a string' }, inputTokenCount: 'many' });
    await expect(processor.process(bad, 'peer-a')).resolves.toBe(false);
    expect(verifies).toBe(0);
    expect(probes).toBe(0);

    await expect(processor.process(GOOD['quote-request'], 'peer-b')).resolves.toBe(true);
    expect(verifies).toBe(1);
  });
});
