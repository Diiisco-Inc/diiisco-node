/**
 * Per-model performance figures (plan 018): time to first token cold and hot,
 * and decode tokens/s. A benchmark seeds them, then every live chat inference
 * keeps them current, as the median of the last few samples.
 *
 * The figures are kept in `model-benchmarks.json` beside the peer identity: no
 * prompts, no completions, only numbers and model ids.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModelInfo } from '../types/models';
import type { ColdStartMethod, ModelPerformance, PerformanceFigure } from '../types/performance';
import { logger } from './logger';
import { toSample, type InferenceObserver, type InferenceSample, type OpenAIInferenceModel, type Warmth } from './models';
import type { OllamaRuntime } from './ollamaRuntime';
import { version } from './version';

/** Samples kept per figure; the published value is their median. */
export const WINDOW = 20;
/**
 * Time to first token grows with the prompt, and agent prompts run to tens of
 * thousands of tokens, so only samples with a prompt about the benchmark's size
 * are comparable. Longer ones still count towards tokens/s.
 */
export const MAX_TTFT_PROMPT_TOKENS = 1024;
/** Too few output tokens and the decode rate is mostly noise. */
export const MIN_DECODE_TOKENS = 16;
/** A model used this recently is taken to be loaded; Ollama's default keep-alive is 5 minutes. */
export const RECENT_USE_MS = 5 * 60_000;
const FLUSH_DELAY_MS = 60_000;

export interface PerformanceRecord {
  model: string;
  /** Ollama's digest when the model was benchmarked; a change means a different model. */
  digest?: string;
  diiiscoVersion: string;
  /** Unset until a benchmark has completed for this model: "no record" in plan terms. */
  benchmarkedAt?: number;
  coldStart?: ColdStartMethod;
  windows: { ttftColdMs: number[]; ttftHotMs: number[]; tokensPerSecond: number[] };
  updatedAt: number;
}

const emptyWindows = (): PerformanceRecord['windows'] => ({ ttftColdMs: [], ttftHotMs: [], tokensPerSecond: [] });

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function figure(values: number[], digits: number): PerformanceFigure | undefined {
  if (values.length === 0) return undefined;
  const factor = 10 ** digits;
  return { value: Math.round(median(values) * factor) / factor, samples: values.length };
}

const finiteList = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0).slice(-WINDOW) : [];

function push(window: number[], value: number): void {
  window.push(value);
  if (window.length > WINDOW) window.splice(0, window.length - WINDOW);
}

export interface PerformanceStoreOptions {
  flushDelayMs?: number;
  now?: () => number;
}

export class PerformanceStore {
  private readonly records = new Map<string, PerformanceRecord>();
  private readonly flushDelayMs: number;
  private readonly now: () => number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /** `path` undefined keeps the figures in memory only. */
  constructor(private readonly path: string | undefined, options: PerformanceStoreOptions = {}) {
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  /** Read the file. A missing one is normal; a corrupt one is reported and replaced on the next write. */
  load(): void {
    if (!this.path) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      for (const [model, r] of Object.entries<any>(parsed?.records ?? {})) {
        if (typeof r !== 'object' || r === null) continue;
        this.records.set(model, {
          model,
          digest: typeof r.digest === 'string' ? r.digest : undefined,
          diiiscoVersion: typeof r.diiiscoVersion === 'string' ? r.diiiscoVersion : version(),
          benchmarkedAt: Number.isFinite(r.benchmarkedAt) ? r.benchmarkedAt : undefined,
          coldStart: r.coldStart === 'forced' || r.coldStart === 'observed' ? r.coldStart : undefined,
          windows: {
            ttftColdMs: finiteList(r.windows?.ttftColdMs),
            ttftHotMs: finiteList(r.windows?.ttftHotMs),
            tokensPerSecond: finiteList(r.windows?.tokensPerSecond),
          },
          updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
        });
      }
    } catch (err) {
      logger.warn(`⚠️ Ignoring unreadable model performance file ${this.path} (${(err as Error).message}); models will be re-measured.`);
      this.records.clear();
    }
  }

  get(model: string): PerformanceRecord | undefined {
    return this.records.get(model);
  }

  models(): string[] {
    return [...this.records.keys()];
  }

  /** Whether `model` needs a benchmark: never benchmarked, or (on Ollama) replaced since. */
  needsBenchmark(model: string, digest?: string): boolean {
    const record = this.records.get(model);
    if (!record?.benchmarkedAt) return true;
    return digest !== undefined && record.digest !== undefined && digest !== record.digest;
  }

  /**
   * Fold one sample in. Which figures it may move depends on what is known
   * about it (see the constants above); a sample that can move none is dropped.
   */
  addSample(model: string, warmth: Warmth, sample: InferenceSample, options: { coldStart?: ColdStartMethod } = {}): void {
    const updates: [keyof PerformanceRecord['windows'], number][] = [];

    if (sample.completionTokens >= MIN_DECODE_TOKENS && sample.decodeMs > 0) {
      updates.push(['tokensPerSecond', (sample.completionTokens - 1) / (sample.decodeMs / 1000)]);
    }
    const comparablePrompt = sample.promptTokens !== undefined && sample.promptTokens <= MAX_TTFT_PROMPT_TOKENS;
    if (comparablePrompt && sample.ttftMs >= 0) {
      if (warmth === 'hot') updates.push(['ttftHotMs', sample.ttftMs]);
      if (warmth === 'cold') updates.push(['ttftColdMs', sample.ttftMs]);
    }
    if (updates.length === 0) return;

    const record = this.ensureRecord(model);
    for (const [key, value] of updates) push(record.windows[key], value);
    if (warmth === 'cold' && updates.some(([key]) => key === 'ttftColdMs')) {
      // A forced cold start is the stronger evidence; a later observed one does not demote it.
      record.coldStart = options.coldStart ?? record.coldStart ?? 'observed';
    }
    record.updatedAt = this.now();
    this.scheduleFlush();
  }

  /**
   * Replace a model's figures with a fresh benchmark's. Done in one step after
   * the benchmark succeeds, so a failed one leaves the old figures standing.
   */
  replaceWithBenchmark(model: string, digest: string | undefined, samples: { warmth: Warmth; sample: InferenceSample; coldStart?: ColdStartMethod }[]): void {
    this.records.set(model, {
      model,
      digest,
      diiiscoVersion: version(),
      benchmarkedAt: this.now(),
      windows: emptyWindows(),
      updatedAt: this.now(),
    });
    for (const { warmth, sample, coldStart } of samples) this.addSample(model, warmth, sample, { coldStart });
    this.flush();
  }

  /** The published figures for `model`, or `undefined` if it has none. */
  performanceFor(model: string): ModelPerformance | undefined {
    const record = this.records.get(model);
    if (!record) return undefined;
    const ttftColdMs = figure(record.windows.ttftColdMs, 0);
    const ttftHotMs = figure(record.windows.ttftHotMs, 0);
    const tokensPerSecond = figure(record.windows.tokensPerSecond, 1);
    if (!ttftColdMs && !ttftHotMs && !tokensPerSecond) return undefined;
    return {
      ...(ttftColdMs ? { ttftColdMs } : {}),
      ...(ttftHotMs ? { ttftHotMs } : {}),
      ...(tokensPerSecond ? { tokensPerSecond } : {}),
      updatedAt: record.updatedAt,
      ...(ttftColdMs && record.coldStart ? { coldStart: record.coldStart } : {}),
    };
  }

  /** Write now if anything changed. Never throws. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty && this.records.size === 0) return;
    this.dirty = false;
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, records: Object.fromEntries(this.records) }, null, 2), 'utf8');
      renameSync(tmp, this.path);
    } catch (err) {
      logger.warn(`⚠️ Could not save model performance figures to ${this.path}: ${(err as Error).message}`);
    }
  }

  /** Final write on shutdown. */
  close(): void {
    if (this.dirty) this.flush();
    else if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private ensureRecord(model: string): PerformanceRecord {
    let record = this.records.get(model);
    if (!record) {
      record = { model, diiiscoVersion: version(), windows: emptyWindows(), updatedAt: this.now() };
      this.records.set(model, record);
    }
    return record;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }
}

/**
 * Says whether a model was loaded when a request went out. Ollama is asked
 * (`/api/ps`); for other runtimes all that is known is whether this node used
 * the model recently, which can say "hot" but never "cold".
 */
export class WarmthTracker {
  private readonly lastUse = new Map<string, number>();

  constructor(private readonly ollama: Pick<OllamaRuntime, 'loaded'>, private readonly now: () => number = Date.now) {}

  async before(model: string): Promise<Warmth> {
    const last = this.lastUse.get(model);
    this.lastUse.set(model, this.now());
    const loaded = await this.ollama.loaded(model);
    if (loaded === true) return 'hot';
    if (loaded === false) return 'cold';
    return last !== undefined && this.now() - last < RECENT_USE_MS ? 'hot' : 'unknown';
  }
}

/** The observer `getResponse` reports live inference to. Never throws into a request. */
export function performanceObserver(store: PerformanceStore, warmth: WarmthTracker): InferenceObserver {
  return {
    begin: (model) => warmth.before(model).catch(() => 'unknown' as const),
    record: (model, w, sample) => {
      try {
        store.addSample(model, w, sample);
        logger.debug(`📏 ${model}: ${w} sample, ttft ${Math.round(sample.ttftMs)} ms, ${sample.completionTokens} tokens in ${Math.round(sample.decodeMs)} ms`);
      } catch (err) {
        logger.debug(`Could not record a performance sample for ${model}: ${(err as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

const BENCHMARK_MESSAGES: ChatCompletionMessageParam[] = [
  { role: 'user', content: 'Write one paragraph, about 100 words, on the history of the bicycle.' },
];
const BENCHMARK_PARAMS = { max_tokens: 128, temperature: 0 };
const HOT_RUNS = 3;
const COLD_TIMEOUT_MS = 180_000;
const HOT_TIMEOUT_MS = 60_000;

export interface BenchmarkResult {
  model: string;
  ok: boolean;
  performance?: ModelPerformance;
  error?: string;
}

export interface BenchmarkerDeps {
  backend: Pick<OpenAIInferenceModel, 'chatTimed'>;
  store: PerformanceStore;
  warmth: WarmthTracker;
  ollama: Pick<OllamaRuntime, 'isOllama' | 'digest' | 'unload'>;
  timeouts?: { coldMs?: number; hotMs?: number };
}

/**
 * Runs benchmarks one at a time, in the background. `ensure` is called after
 * every availability probe and only queues what has no figures (or, on Ollama,
 * a model whose digest changed since); `run` is `diiisco benchmark`.
 */
export class Benchmarker {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly queued = new Map<string, Promise<BenchmarkResult>>();
  /** Models already checked since they (re)appeared, so a 30 s poll does not ask for digests every time. */
  private readonly checked = new Set<string>();
  private readonly abort = new AbortController();
  private readonly coldMs: number;
  private readonly hotMs: number;

  constructor(private readonly deps: BenchmarkerDeps) {
    this.coldMs = deps.timeouts?.coldMs ?? COLD_TIMEOUT_MS;
    this.hotMs = deps.timeouts?.hotMs ?? HOT_TIMEOUT_MS;
  }

  /** Queue whatever served chat models still need measuring. Cheap and idempotent. */
  ensure(models: ModelInfo[]): void {
    const chat = models.filter((m) => (m.kind ?? 'chat') === 'chat').map((m) => m.id);
    const present = new Set(chat);
    for (const id of [...this.checked]) if (!present.has(id)) this.checked.delete(id);
    for (const id of chat) {
      if (this.checked.has(id)) continue;
      this.checked.add(id);
      void this.enqueue(id, false);
    }
  }

  /** Measure `models` now (after anything already queued) and resolve with the results. */
  run(models: string[]): Promise<BenchmarkResult[]> {
    return Promise.all(models.map((id) => this.enqueue(id, true)));
  }

  /** Abandon the run in progress and anything queued; for shutdown. */
  stop(): void {
    this.abort.abort();
  }

  private enqueue(model: string, force: boolean): Promise<BenchmarkResult> {
    const existing = this.queued.get(model);
    if (existing) return existing;
    const job = this.chain.then(() => this.measureIfNeeded(model, force)).finally(() => this.queued.delete(model));
    this.queued.set(model, job);
    this.chain = job.catch(() => {});
    return job;
  }

  private async measureIfNeeded(model: string, force: boolean): Promise<BenchmarkResult> {
    if (this.abort.signal.aborted) return { model, ok: false, error: 'the node is shutting down' };
    const digest = await this.deps.ollama.digest(model);
    if (!force && !this.deps.store.needsBenchmark(model, digest)) {
      return { model, ok: true, performance: this.deps.store.performanceFor(model) };
    }
    try {
      return await this.measure(model, digest);
    } catch (err) {
      const error = this.abort.signal.aborted ? 'the node is shutting down' : String((err as Error)?.message ?? err).replace(/\.+$/, '');
      if (!this.abort.signal.aborted) logger.warn(`⚠️ Could not benchmark ${model}: ${error}. It will be tried again on the next start.`);
      return { model, ok: false, error };
    }
  }

  private async measure(model: string, digest: string | undefined): Promise<BenchmarkResult> {
    logger.info(`📏 Benchmarking ${model} (time to first token and tokens/s)…`);
    const samples: { warmth: Warmth; sample: InferenceSample; coldStart?: ColdStartMethod }[] = [];

    // A cold start is only timed when one can be made to happen: Ollama unloads
    // on request. Elsewhere the first run's warmth is whatever is known about it.
    const forced = (await this.deps.ollama.isOllama()) && (await this.deps.ollama.unload(model, this.abort.signal));
    const firstWarmth: Warmth = forced ? 'cold' : await this.deps.warmth.before(model);
    const first = await this.once(model, forced ? this.coldMs : this.hotMs);
    if (first) samples.push({ warmth: firstWarmth, sample: first, coldStart: forced ? 'forced' : undefined });

    for (let i = 0; i < HOT_RUNS; i++) {
      await this.deps.warmth.before(model);
      const sample = await this.once(model, this.hotMs);
      if (sample) samples.push({ warmth: 'hot', sample });
    }
    if (samples.length === 0) throw new Error('the model produced no output');

    this.deps.store.replaceWithBenchmark(model, digest, samples);
    const performance = this.deps.store.performanceFor(model);
    logger.info(`📏 ${model}: ${describePerformance(performance)}`);
    return { model, ok: true, performance };
  }

  private async once(model: string, timeoutMs: number): Promise<InferenceSample | null> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    const { completion, timing } = await this.deps.backend.chatTimed(model, BENCHMARK_MESSAGES, BENCHMARK_PARAMS, signal);
    return timing ? toSample(timing, completion, BENCHMARK_MESSAGES, BENCHMARK_PARAMS) : null;
  }
}

/** `cold 2140 ms, hot 85 ms, 54.2 tok/s (forced cold)` — for logs and the CLI. */
export function describePerformance(p: ModelPerformance | undefined): string {
  if (!p) return 'no figures yet';
  const parts = [
    `cold ${p.ttftColdMs ? `${p.ttftColdMs.value} ms` : '—'}`,
    `hot ${p.ttftHotMs ? `${p.ttftHotMs.value} ms` : '—'}`,
    `${p.tokensPerSecond ? p.tokensPerSecond.value : '—'} tok/s`,
  ];
  return `${parts.join(', ')}${p.coldStart ? ` (${p.coldStart} cold)` : ''}`;
}
