/**
 * Tags and performance in quotes (plan 018). The provider sends what it has —
 * whatever `publicStats` says, since only the requester sees a quote — and the
 * requester checks the shape of these self-reported claims before anything
 * reads them: a malformed claim sinks the quote, a missing one does not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import environment, { configureEnvironment } from '../src/environment/runtime';
import type { ModelAvailability } from '../src/utils/modelAvailability';
import type { PubSubMessage, QuoteRequest, QuoteResponse } from '../src/types/messages';
import type { ModelPerformance } from '../src/types/performance';
import { isValidQuoteResponse } from '../src/utils/quoteEngine';

const WALLET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PERF: ModelPerformance = {
  ttftColdMs: { value: 2100, samples: 1 },
  ttftHotMs: { value: 85, samples: 6 },
  tokensPerSecond: { value: 54.2, samples: 12 },
  updatedAt: 1_800_000_000_000,
  coldStart: 'forced',
};

beforeAll(() => {
  configureEnvironment({ local: { enabled: true, privateTopic: 'quote-node-info-test/models/1.0.0' } });
});
afterAll(() => {
  if (environment.node) {
    delete environment.node.tags;
    delete environment.node.publicStats;
  }
});

function availability(served: Record<string, 'chat' | 'decision' | 'embedding'>): ModelAvailability {
  const ids = Object.keys(served);
  return {
    list: () => ids,
    models: () => ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'test', kind: served[id] })) as any,
    kindOf: (id: string) => served[id] ?? 'chat',
    isChat: (id: string) => (served[id] ?? 'chat') === 'chat',
    isAvailable: (id: string) => id in served,
    ensureAvailable: async (id: string) => id in served,
    refresh: async () => ids,
    isHealthy: () => true,
    invalidate: () => {},
    start: () => {},
    stop: () => {},
  };
}

function provider(performance: Record<string, ModelPerformance> | null) {
  const sent: PubSubMessage[] = [];
  const algo = {
    account: { addr: { toString: () => WALLET } },
    signObject: async () => 'signature',
    isValidAddress: () => true,
    verifySignature: async () => true,
    nfdVerified: false,
    checkIfOptedInToAsset: async () => ({ optedIn: true, balance: 1n }),
  };
  const { MessageProcessor } = require('../src/messaging/messageProcessor');
  const { RequestLedger } = require('../src/messaging/requestLedger');
  const { ModelListCollector } = require('../src/messaging/modelListCollector');
  const { SettlementQueue } = require('../src/settlement/settlementQueue');
  const quoteEngineModule = require('../src/utils/quoteEngine');
  const processor = new MessageProcessor(
    algo,
    { getModels: async () => [], getResponse: async () => ({}) },
    new quoteEngineModule.default({ emit: () => {} }, algo),
    availability({ gemma3: 'chat', tev: 'decision' }),
    { emit: () => {} },
    { sendMessage: async (msg: PubSubMessage) => { sent.push(msg); } },
    'peer-self',
    { peerStore: { merge: async () => {} } },
    new RequestLedger(),
    new ModelListCollector(),
    new SettlementQueue(),
    performance ? { performanceFor: (model: string) => performance[model] } : null,
  );
  return { processor, sent };
}

let requestCounter = 0;
const quoteRequest = (model: string, kind?: 'systemone'): QuoteRequest => ({
  role: 'quote-request',
  from: 'peer-requester',
  fromWalletAddr: WALLET,
  timestamp: Date.now(),
  id: `request-${++requestCounter}`,
  payload: { model, inputTokenCount: 100, max_tokens: 256, maxSpend: 0.05, ...(kind ? { kind } : {}) },
  signature: 'signature',
});

const sentQuote = (sent: PubSubMessage[]) => (sent[0] as QuoteResponse).payload.quote;

describe('the provider', () => {
  test('sends its tags and its figures for the model', async () => {
    environment.node = { ...environment.node, tags: ['apple-silicon', 'apple-silicon-m4-pro'] };
    const { processor, sent } = provider({ gemma3: PERF });
    await processor.process(quoteRequest('gemma3'), 'peer-requester');
    expect(sentQuote(sent).tags).toEqual(['apple-silicon', 'apple-silicon-m4-pro']);
    expect(sentQuote(sent).performance).toEqual(PERF);
  });

  test('sends neither when it has neither', async () => {
    environment.node = { ...environment.node, tags: undefined };
    const { processor, sent } = provider(null);
    await processor.process(quoteRequest('gemma3'), 'peer-requester');
    expect('tags' in sentQuote(sent)).toBe(false);
    expect('performance' in sentQuote(sent)).toBe(false);
  });

  test('an empty tag list is not sent', async () => {
    environment.node = { ...environment.node, tags: [] };
    const { processor, sent } = provider(null);
    await processor.process(quoteRequest('gemma3'), 'peer-requester');
    expect('tags' in sentQuote(sent)).toBe(false);
  });

  test('a System One quote carries no chat performance figures', async () => {
    const { processor, sent } = provider({ tev: PERF });
    await processor.process(quoteRequest('tev', 'systemone'), 'peer-requester');
    expect(sent.length).toBe(1);
    expect('performance' in sentQuote(sent)).toBe(false);
  });

  test('publicStats: false still sends figures in quotes', async () => {
    environment.node = { ...environment.node, publicStats: false };
    const { processor, sent } = provider({ gemma3: PERF });
    await processor.process(quoteRequest('gemma3'), 'peer-requester');
    expect(sentQuote(sent).performance).toEqual(PERF);
  });
});

const response = (quoteExtras: Record<string, unknown>): QuoteResponse => ({
  role: 'quote-response',
  timestamp: Date.now(),
  to: 'peer-requester',
  id: 'request-x',
  fromWalletAddr: WALLET,
  payload: {
    quote: {
      model: 'gemma3', tokenCount: 100, addr: WALLET, pricePerInputToken1M: 0.01, pricePerOutputToken1M: 0.01,
      ...quoteExtras,
    },
  },
});

describe('the requester', () => {
  test('accepts a quote without the new fields (an older provider)', () => {
    expect(isValidQuoteResponse(response({}))).toBe(true);
  });

  test('accepts well-formed tags and figures', () => {
    expect(isValidQuoteResponse(response({ tags: ['cuda'], performance: PERF }))).toBe(true);
  });

  test.each([
    ['tags that are not a list', { tags: 'cuda' }],
    ['a tag that is not a string', { tags: [7] }],
    ['an over-long tag', { tags: ['x'.repeat(49)] }],
    ['too many tags', { tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }],
    ['performance that is not an object', { performance: 'fast' }],
    ['a negative tokens/s', { performance: { ...PERF, tokensPerSecond: { value: -1, samples: 1 } } }],
    ['an infinite TTFT', { performance: { ...PERF, ttftHotMs: { value: Infinity, samples: 1 } } }],
    ['an absurd tokens/s', { performance: { ...PERF, tokensPerSecond: { value: 1e9, samples: 1 } } }],
    ['zero samples', { performance: { ...PERF, ttftHotMs: { value: 80, samples: 0 } } }],
    ['an unknown cold-start method', { performance: { ...PERF, coldStart: 'guessed' } }],
    ['no updatedAt', { performance: { tokensPerSecond: { value: 50, samples: 1 } } }],
  ])('rejects a quote with %s', (_label, extras) => {
    expect(isValidQuoteResponse(response(extras))).toBe(false);
  });

  test('candidates carry the cleaned claims, and tags [] when none were sent', async () => {
    const quoteEngineModule = require('../src/utils/quoteEngine');
    const engine = new quoteEngineModule.default({ emit: () => {} }, {});
    const withExtra = response({ tags: ['cuda'], performance: { ...PERF, extra: 'dropped' } });
    const [rich, bare] = await engine.buildCandidates([
      { msg: withExtra, from: 'peer-a', receivedAt: Date.now() },
      { msg: response({}), from: 'peer-b', receivedAt: Date.now() },
    ]);
    expect(rich.tags).toEqual(['cuda']);
    expect(rich.performance).toEqual(PERF);
    expect(bare.tags).toEqual([]);
    expect(bare.performance).toBeUndefined();
  });
});
