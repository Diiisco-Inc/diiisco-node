/**
 * Per-peer limits (review M1): a peer cannot make this node verify signatures
 * and query algod/NFD without bound, and the opt-in lookups a stranger can
 * provoke are cached, shared and capped.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { configureEnvironment } from '../src/environment/runtime';
import { RateLimiter, perMinute } from '../src/utils/rateLimiter';
import { ExpiringMap } from '../src/utils/expiringMap';

describe('RateLimiter', () => {
  test('allows a burst, then refuses, then refills over time', () => {
    let now = 0;
    const l = new RateLimiter({ capacity: 3, refillPerMs: 1 / 1000, now: () => now });
    expect([l.take('a'), l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, true, false]);
    now = 1000; // one token back
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(false);
  });

  test('keys are independent', () => {
    const l = new RateLimiter({ capacity: 1, refillPerMs: 0 });
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(false);
    expect(l.take('b')).toBe(true);
  });

  test('a refused request spends nothing and the bucket never exceeds capacity', () => {
    let now = 0;
    const l = new RateLimiter({ capacity: 2, refillPerMs: 1, now: () => now });
    l.take('a'); l.take('a');
    expect(l.take('a')).toBe(false);
    now = 1_000_000;
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, false]);
  });

  test('the table is bounded however many keys arrive', () => {
    const l = new RateLimiter({ capacity: 5, refillPerMs: 0.001, maxKeys: 100 });
    for (let i = 0; i < 10_000; i++) l.take(`peer-${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
  });

  test('perMinute builds a per-minute rate', () => {
    let now = 0;
    const l = new RateLimiter({ capacity: 1, refillPerMs: 60 / 60_000, now: () => now });
    l.take('a');
    now = 1000;
    expect(l.take('a')).toBe(true);
    expect(perMinute(60, 30).take('x')).toBe(true);
  });
});

describe('ExpiringMap maxEntries', () => {
  test('drops the oldest entry when full', () => {
    const m = new ExpiringMap<string, number>(30_000, 2);
    m.set('a', 1, 60_000); m.set('b', 2, 60_000); m.set('c', 3, 60_000);
    expect(m.get('a')).toBeUndefined();
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
  });
});

describe('MessageProcessor per-peer budget', () => {
  beforeAll(() => {
    configureEnvironment({
      local: { enabled: true, privateTopic: 'rate-limit-test/models/1.0.0' },
      node: { rateLimit: { requestsPerMinute: 1, burst: 5 } },
    } as any);
  });

  const WALLET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  function build() {
    const checks: string[] = [];
    let verifies = 0;
    const algo: any = {
      account: { addr: { toString: () => WALLET } },
      signObject: async () => 'sig',
      isValidAddress: () => true,
      verifySignature: async () => { verifies += 1; return true; },
      nfdVerified: false,
      checkIfOptedInToAsset: async () => ({ optedIn: true, balance: 1n }),
    };
    const models: any = {
      ensureAvailable: async (id: string) => { checks.push(id); return false; },
      list: () => [], models: () => [], kindOf: () => 'chat', isAvailable: () => false,
      invalidate: () => {},
    };
    const { MessageProcessor } = require('../src/messaging/messageProcessor');
    const quoteEngineModule = require('../src/utils/quoteEngine');
    const processor = new MessageProcessor(
      algo, { getModels: async () => [] }, new quoteEngineModule.default({ emit: () => {} }, algo),
      models, { emit: () => {} }, { sendMessage: async () => {} }, 'peer-self', { peerStore: { merge: async () => {} } },
    );
    return { processor, checks, verifies: () => verifies };
  }

  const quoteRequest = (n: number): any => ({
    role: 'quote-request', fromWalletAddr: WALLET, timestamp: Date.now(), id: `r${n}`, signature: 's',
    payload: { model: 'm', inputTokenCount: 1, max_tokens: 1, maxSpend: 1 },
  });

  test('a flood from one peer is cut off before signatures are checked; another peer is unaffected', async () => {
    const { processor, checks, verifies } = build();
    for (let i = 0; i < 200; i++) await processor.process(quoteRequest(i), 'flooder');
    expect(verifies()).toBe(5); // burst only
    expect(checks.length).toBe(5);

    await processor.process(quoteRequest(1000), 'honest-peer');
    expect(verifies()).toBe(6);
  });

  test('this node\'s own messages are exempt', async () => {
    const { processor, verifies } = build();
    for (let i = 0; i < 50; i++) await processor.process(quoteRequest(i), 'peer-self');
    expect(verifies()).toBe(50);
  });

  test('answers have a larger budget than requests', async () => {
    const { processor, verifies } = build();
    const response: any = { role: 'inference-failed', fromWalletAddr: WALLET, timestamp: Date.now(), id: 'x', signature: 's', payload: {} };
    for (let i = 0; i < 100; i++) await processor.process(response, 'provider');
    expect(verifies()).toBe(20); // 4 x the burst of 5
  });
});

describe('algorand opt-in lookups for strangers', () => {
  function makeAlgo(calls: { n: number }, delayMs = 0) {
    const algorand = require('../src/utils/algorand').default;
    configureEnvironment({ local: { enabled: true, privateTopic: 'lookup-cache-test/models/1.0.0' } } as any);
    const algo = new algorand();
    algo.algod = {
      accountInformation: () => ({
        do: async () => {
          calls.n += 1;
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          return { assets: [{ assetId: 1n, amount: 5n }] };
        },
      }),
    };
    return algo;
  }

  test('a cached lookup hits algod once; an uncached one every time', async () => {
    const calls = { n: 0 };
    const algo = makeAlgo(calls);
    for (let i = 0; i < 5; i++) expect((await algo.checkIfOptedInToAsset('W', 1, { cache: true })).balance).toBe(5n);
    expect(calls.n).toBe(1);
    await algo.checkIfOptedInToAsset('W', 1);
    await algo.checkIfOptedInToAsset('W', 1);
    expect(calls.n).toBe(3);
  });

  test('concurrent identical lookups share one call', async () => {
    const calls = { n: 0 };
    const algo = makeAlgo(calls, 20);
    await Promise.all(Array.from({ length: 10 }, () => algo.checkIfOptedInToAsset('W', 1, { cache: true })));
    expect(calls.n).toBe(1);
  });

  test('distinct lookups in flight are capped', async () => {
    const calls = { n: 0 };
    const algo = makeAlgo(calls, 30);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => algo.checkIfOptedInToAsset(`W${i}`, 1, { cache: true }))
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(8);
    expect(calls.n).toBe(8);
  });

  test('errors are not cached', async () => {
    const algorand = require('../src/utils/algorand').default;
    configureEnvironment({ local: { enabled: true, privateTopic: 'lookup-cache-test/models/1.0.0' } } as any);
    const algo = new algorand();
    let n = 0;
    algo.algod = { accountInformation: () => ({ do: async () => { n += 1; if (n === 1) throw new Error('algod down'); return { assets: [] }; } }) };
    await expect(algo.checkIfOptedInToAsset('W', 1, { cache: true })).rejects.toThrow();
    expect((await algo.checkIfOptedInToAsset('W', 1, { cache: true })).optedIn).toBe(false);
  });
});
