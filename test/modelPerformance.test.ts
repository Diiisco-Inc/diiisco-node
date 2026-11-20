/**
 * Per-model performance figures (plan 018): what a sample may move, medians
 * over a bounded window, persistence that survives a corrupt file, and
 * benchmarks that run once per model, one at a time, never crash the node and
 * time a real cold start on Ollama.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelInfo } from '../src/types/models';
import { OpenAIInferenceModel, type InferenceSample } from '../src/utils/models';
import {
  Benchmarker, MAX_TTFT_PROMPT_TOKENS, MIN_DECODE_TOKENS, PerformanceStore, WINDOW, WarmthTracker,
} from '../src/utils/modelPerformance';
import { OllamaRuntime } from '../src/utils/ollamaRuntime';
import { makeHome, removeHome } from './helpers';
import { startStubBackend, words, type StubBackend, type StubBehaviour } from './stubBackend';

const sample = (over: Partial<InferenceSample> = {}): InferenceSample => ({
  ttftMs: 100, decodeMs: 1000, promptTokens: 50, completionTokens: 101, ...over,
});

let home: string;
beforeEach(() => { home = makeHome('diiisco-perf-'); });
afterEach(() => removeHome(home));

describe('PerformanceStore', () => {
  test('tokens/s is (completion − 1) / decode seconds', () => {
    const store = new PerformanceStore(undefined);
    store.addSample('m', 'unknown', sample({ completionTokens: 101, decodeMs: 2000 }));
    expect(store.performanceFor('m')?.tokensPerSecond).toEqual({ value: 50, samples: 1 });
  });

  test('a sample moves only the figures it is evidence for', () => {
    const store = new PerformanceStore(undefined);
    store.addSample('m', 'unknown', sample());                                              // tok/s only
    store.addSample('m', 'hot', sample({ promptTokens: MAX_TTFT_PROMPT_TOKENS + 1 }));      // long prompt: tok/s only
    store.addSample('m', 'hot', sample({ promptTokens: undefined }));                       // unknown prompt: tok/s only
    store.addSample('m', 'hot', sample({ completionTokens: MIN_DECODE_TOKENS - 1 }));       // short output: hot TTFT only
    const p = store.performanceFor('m')!;
    expect(p.tokensPerSecond?.samples).toBe(3);
    expect(p.ttftHotMs?.samples).toBe(1);
    expect(p.ttftColdMs).toBeUndefined();
    expect(p.coldStart).toBeUndefined();
  });

  test('a cold sample sets the cold figure, observed unless forced; forced is not demoted', () => {
    const store = new PerformanceStore(undefined);
    store.addSample('m', 'cold', sample({ ttftMs: 3000 }));
    expect(store.performanceFor('m')?.coldStart).toBe('observed');
    store.addSample('m', 'cold', sample({ ttftMs: 3000 }), { coldStart: 'forced' });
    store.addSample('m', 'cold', sample({ ttftMs: 3000 }));
    expect(store.performanceFor('m')?.coldStart).toBe('forced');
  });

  test(`windows keep the last ${WINDOW} samples and publish their median`, () => {
    const store = new PerformanceStore(undefined);
    for (let i = 1; i <= WINDOW + 10; i++) store.addSample('m', 'hot', sample({ ttftMs: i }));
    const hot = store.performanceFor('m')!.ttftHotMs!;
    expect(hot.samples).toBe(WINDOW);
    // Samples 11..30 remain; their median is 20.5, published to whole ms.
    expect(hot.value).toBe(21);
  });

  test('one outlier does not swing the figure', () => {
    const store = new PerformanceStore(undefined);
    for (const t of [80, 82, 85, 9000, 84]) store.addSample('m', 'hot', sample({ ttftMs: t }));
    expect(store.performanceFor('m')!.ttftHotMs!.value).toBe(84);
  });

  test('persists, debounced, and close() flushes', () => {
    const path = join(home, 'model-benchmarks.json');
    const store = new PerformanceStore(path, { flushDelayMs: 60_000 });
    store.addSample('m', 'hot', sample());
    expect(existsSync(path)).toBe(false);
    store.close();
    const again = new PerformanceStore(path);
    again.load();
    expect(again.performanceFor('m')?.ttftHotMs?.value).toBe(100);
    expect(readFileSync(path, 'utf8')).not.toContain('content');
  });

  test('a corrupt file is ignored and the node carries on', () => {
    const path = join(home, 'model-benchmarks.json');
    writeFileSync(path, '{ not json');
    const store = new PerformanceStore(path);
    expect(() => store.load()).not.toThrow();
    expect(store.models()).toEqual([]);
    expect(store.needsBenchmark('m')).toBe(true);
  });

  test('live samples alone do not count as a benchmark; a changed digest needs a new one', () => {
    const store = new PerformanceStore(undefined);
    store.addSample('m', 'hot', sample());
    expect(store.needsBenchmark('m')).toBe(true);
    store.replaceWithBenchmark('m', 'sha256:aaa', [{ warmth: 'hot', sample: sample() }]);
    expect(store.needsBenchmark('m', 'sha256:aaa')).toBe(false);
    expect(store.needsBenchmark('m', 'sha256:bbb')).toBe(true);
  });
});

describe('Benchmarker', () => {
  let stub: StubBackend;
  afterEach(() => stub?.stop());

  function setup(behaviour: StubBehaviour, timeouts?: { coldMs?: number; hotMs?: number }) {
    stub = startStubBackend(behaviour);
    const backend = new OpenAIInferenceModel(`${stub.url}/v1`, new EventEmitter());
    const ollama = new OllamaRuntime(stub.url);
    const store = new PerformanceStore(join(home, 'model-benchmarks.json'));
    const warmth = new WarmthTracker(ollama);
    const benchmarker = new Benchmarker({ backend, store, warmth, ollama, timeouts });
    return { backend, store, benchmarker };
  }

  const chat = (id: string, kind?: ModelInfo['kind']): ModelInfo => ({ id, object: 'model', created: 0, owned_by: 'x', ...(kind ? { kind } : {}) });

  test('on Ollama, unloads first and times a forced cold start, then hot runs', async () => {
    const { store, benchmarker } = setup({ ollama: true, chunks: words(20), firstTokenDelayMs: 30, interChunkDelayMs: 5 });
    stub.loaded.add('m:latest');
    const [result] = await benchmarker.run(['m:latest']);
    expect(result.ok).toBe(true);
    expect(stub.unloads).toEqual(['m:latest']);
    expect(stub.requests.length).toBe(4); // 1 cold + 3 hot
    const p = store.performanceFor('m:latest')!;
    expect(p.coldStart).toBe('forced');
    expect(p.ttftColdMs?.samples).toBe(1);
    expect(p.ttftHotMs?.samples).toBe(3);
    expect(p.tokensPerSecond?.samples).toBe(4);
  });

  test('elsewhere, no cold figure is claimed', async () => {
    const { store, benchmarker } = setup({ chunks: words(20) });
    await benchmarker.run(['m']);
    const p = store.performanceFor('m')!;
    expect(p.ttftColdMs).toBeUndefined();
    expect(p.ttftHotMs?.samples).toBe(3);
  });

  test('ensure measures chat models with no record, once, and skips other kinds', async () => {
    const { store, benchmarker } = setup({ chunks: words(20) });
    const list = [chat('a'), chat('e', 'embedding'), chat('d', 'decision')];
    benchmarker.ensure(list);
    benchmarker.ensure(list); // a second probe while the first is running
    await benchmarker.run([]); // let the queue drain
    await Bun.sleep(50);
    while (stub.requests.length < 4) await Bun.sleep(20);
    await Bun.sleep(50);
    expect(store.models()).toEqual(['a']);
    expect(stub.requests.every((r) => r.body.model === 'a')).toBe(true);
    expect(stub.requests.length).toBe(4);
  });

  test('a model that already has a record is not re-measured on start', async () => {
    const first = setup({ chunks: words(20) });
    await first.benchmarker.run(['a']);
    stub.stop();

    const second = setup({ chunks: words(20) });
    second.store.load();
    second.benchmarker.ensure([chat('a')]);
    await Bun.sleep(200);
    expect(stub.requests.length).toBe(0);
  });

  test('a changed Ollama digest triggers a re-measure', async () => {
    const first = setup({ ollama: true, chunks: words(20) });
    first.store.load();
    stub.digests.set('a:latest', 'sha256:one');
    await first.benchmarker.run(['a:latest']);
    stub.stop();

    const second = setup({ ollama: true, chunks: words(20) });
    second.store.load();
    stub.digests.set('a:latest', 'sha256:two');
    second.benchmarker.ensure([chat('a:latest')]);
    while (stub.requests.length < 4) await Bun.sleep(20);
    await Bun.sleep(50);
    expect(second.store.get('a:latest')?.digest).toBe('sha256:two');
  });

  test('a hung backend times out, leaves no record and does not throw', async () => {
    const { store, benchmarker } = setup({ hang: true }, { coldMs: 200, hotMs: 200 });
    const [result] = await benchmarker.run(['m']);
    expect(result.ok).toBe(false);
    expect(store.needsBenchmark('m')).toBe(true);
  });

  test('a failed re-measure leaves the old figures standing', async () => {
    const { store, benchmarker } = setup({ chunks: words(20) });
    await benchmarker.run(['m']);
    const before = store.performanceFor('m');
    stub.behaviour = { hang: true };
    const hung = new Benchmarker({
      backend: new OpenAIInferenceModel(`${stub.url}/v1`, new EventEmitter()),
      store, warmth: new WarmthTracker(new OllamaRuntime(stub.url)), ollama: new OllamaRuntime(stub.url),
      timeouts: { coldMs: 150, hotMs: 150 },
    });
    const [result] = await hung.run(['m']);
    expect(result.ok).toBe(false);
    expect(store.performanceFor('m')).toEqual(before);
  });

  test('stop() abandons the run in progress', async () => {
    const { benchmarker } = setup({ hang: true });
    const pending = benchmarker.run(['m']);
    await Bun.sleep(50);
    benchmarker.stop();
    const [result] = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('shutting down');
  });
});
