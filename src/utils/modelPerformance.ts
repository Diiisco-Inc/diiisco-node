/**
 * Per-model performance figures (plan 018): time to first token cold and hot,
 * and decode tokens/s. A benchmark seeds them, then every live inference keeps
 * them current, as the median of the last few samples.
 *
 * Chat and decision models are measured. A decision model answers in one piece
 * (`/v1/systemone`), so its "time to first token" figures hold the whole
 * response time, hot and cold, and it has no tokens/s.
 *
 * The figures are kept in `model-benchmarks.json` beside the peer identity: no
 * prompts, no completions, only numbers and model ids.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import environment from '../environment/runtime';
import { resolvePath } from './paths';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModelInfo, ModelKind } from '../types/models';
import { isMeasured, type ColdStartMethod, type ModelPerformance, type PerformanceFigure } from '../types/performance';
import { logger } from './logger';
import { systemOneSample, toSample, type InferenceObserver, type InferenceSample, type OpenAIInferenceModel, type Warmth } from './models';
import { version } from './version';
import type { RunningModel } from './ollamaRuntime';

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
 * What performance tracking asks of the runtime serving a model. `OllamaRuntime`
 * answers for its one backend; `InferenceBackends` routes each question to the
 * backend serving the model (plan 019). Never throws.
 */
export interface RuntimeProbe {
  isOllama(model: string): Promise<boolean>;
  loaded(model: string): Promise<boolean | undefined>;
  digest(model: string): Promise<string | undefined>;
  unload(model: string, signal?: AbortSignal): Promise<boolean>;
  /** Everything the runtime holds in memory, for the benchmark trace. */
  running(model: string): Promise<RunningModel[] | undefined>;
}

/**
 * Says whether a model was loaded when a request went out. Ollama is asked
 * (`/api/ps`); for other runtimes all that is known is whether this node used
 * the model recently, which can say "hot" but never "cold".
 */
export class WarmthTracker {
  private readonly lastUse = new Map<string, number>();

  constructor(private readonly ollama: Pick<RuntimeProbe, 'loaded'>, private readonly now: () => number = Date.now) {}

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
/** A decision model's benchmark: one small typed question, a few dozen tokens in. */
const BENCHMARK_SYSTEMONE = {
  state: { message: 'My order arrived two weeks late and the box was crushed.' },
  questions: {
    sentiment: {
      type: 'choice',
      instructions: 'How does the customer feel?',
      criteria: { positive: 'Happy or satisfied', neutral: 'Neither', negative: 'Unhappy or frustrated' },
    },
  },
};
const HOT_RUNS = 3;
const COLD_TIMEOUT_MS = 180_000;
const HOT_TIMEOUT_MS = 60_000;

export interface BenchmarkResult {
  model: string;
  ok: boolean;
  /** `--missing`: it already had figures, so it was not measured; `performance` is what it had. */
  skipped?: boolean;
  performance?: ModelPerformance;
  error?: string;
}

/** How `diiisco benchmark` was asked to run, as carried to a running node. */
export interface BenchmarkMode {
  /** Report the figures, measuring nothing. */
  list: boolean;
  /** Measure only models with no figures yet. */
  missingOnly?: boolean;
}

export interface BenchmarkerDeps {
  backend: Pick<OpenAIInferenceModel, 'chatTimed' | 'systemOneTimed'>;
  store: PerformanceStore;
  warmth: WarmthTracker;
  ollama: Pick<RuntimeProbe, 'isOllama' | 'digest' | 'unload' | 'loaded' | 'running'>;
  timeouts?: { coldMs?: number; hotMs?: number };
}

/** Receives each step of a benchmark as one line, for `diiisco benchmark --verbose` (plan 020). */
export type BenchmarkTrace = (line: string) => void;

/** `qwen3:32b (20.1 GB, 19.8 GB on GPU), gemma3:12b (8.4 GB)` — or why it is unknown. */
function describeRunning(models: RunningModel[] | undefined): string {
  if (!models) return 'unknown';
  if (models.length === 0) return 'none';
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
  return models.map((m) => {
    const sizes = [m.sizeBytes !== undefined ? gb(m.sizeBytes) : null, m.vramBytes !== undefined ? `${gb(m.vramBytes)} on GPU` : null].filter(Boolean);
    return sizes.length ? `${m.name} (${sizes.join(', ')})` : m.name;
  }).join(', ');
}

/** One sample in the trace: `first token 412 ms, 128 tokens in 2310 ms (55.4 tok/s)`. */
function describeSample(sample: InferenceSample, kind: ModelKind): string {
  if (kind === 'decision') return `answered in ${Math.round(sample.ttftMs)} ms`;
  const rate = sample.decodeMs > 0 ? ` (${((sample.completionTokens / sample.decodeMs) * 1000).toFixed(1)} tok/s)` : '';
  return `first token ${Math.round(sample.ttftMs)} ms, ${sample.completionTokens} tokens in ${Math.round(sample.decodeMs)} ms${rate}`;
}

/** A model to measure: a bare id is a chat model. */
export type BenchmarkTarget = string | Pick<ModelInfo, 'id' | 'kind'>;

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
  /** Listeners of the `run` calls in progress; they also hear background jobs queued ahead. */
  private readonly tracers = new Set<BenchmarkTrace>();

  constructor(private readonly deps: BenchmarkerDeps) {
    this.coldMs = deps.timeouts?.coldMs ?? COLD_TIMEOUT_MS;
    this.hotMs = deps.timeouts?.hotMs ?? HOT_TIMEOUT_MS;
  }

  /** Queue whatever served chat and decision models still need measuring. Cheap and idempotent. */
  ensure(models: ModelInfo[]): void {
    const measured = models.filter((m) => isMeasured(m.kind));
    const present = new Set(measured.map((m) => m.id));
    for (const id of [...this.checked]) if (!present.has(id)) this.checked.delete(id);
    for (const m of measured) {
      if (this.checked.has(m.id)) continue;
      this.checked.add(m.id);
      void this.enqueue(m.id, m.kind ?? 'chat', false);
    }
  }

  /** Measure `models` now (after anything already queued) and resolve with the results. */
  async run(models: BenchmarkTarget[], options: { onTrace?: BenchmarkTrace; missingOnly?: boolean } = {}): Promise<BenchmarkResult[]> {
    const { onTrace } = options;
    // `--missing` (plan 021) asks exactly what a node asks itself at startup:
    // measure only what has no figures, or (Ollama) a re-pulled model.
    const force = !options.missingOnly;
    if (onTrace) this.tracers.add(onTrace);
    try {
      return await Promise.all(models.map((m) => (typeof m === 'string' ? this.enqueue(m, 'chat', force) : this.enqueue(m.id, m.kind ?? 'chat', force))));
    } finally {
      if (onTrace) this.tracers.delete(onTrace);
    }
  }

  /**
   * One step of a benchmark. Always a debug line, so a node at `logLevel: debug`
   * has the whole sequence in its log — the only record left if the backend
   * takes the machine down with it.
   */
  private note(model: string, text: string): void {
    const line = `📏 ${model}: ${text}`;
    logger.debug(line);
    for (const trace of this.tracers) {
      try {
        trace(line);
      } catch {
        // A listener (a CLI printing, a control reply collecting) must never fail a benchmark.
      }
    }
  }

  /** Abandon the run in progress and anything queued; for shutdown. */
  stop(): void {
    this.abort.abort();
  }

  private enqueue(model: string, kind: ModelKind, force: boolean): Promise<BenchmarkResult> {
    const existing = this.queued.get(model);
    if (existing) return existing;
    const job = this.chain.then(() => this.measureIfNeeded(model, kind, force)).finally(() => this.queued.delete(model));
    this.queued.set(model, job);
    this.chain = job.catch(() => {});
    return job;
  }

  private async measureIfNeeded(model: string, kind: ModelKind, force: boolean): Promise<BenchmarkResult> {
    if (this.abort.signal.aborted) return { model, ok: false, error: 'the node is shutting down' };
    const digest = await this.deps.ollama.digest(model);
    if (!force && !this.deps.store.needsBenchmark(model, digest)) {
      this.note(model, 'already has figures, so it is not measured again');
      return { model, ok: true, skipped: true, performance: this.deps.store.performanceFor(model) };
    }
    try {
      return await this.measure(model, kind, digest);
    } catch (err) {
      const error = this.abort.signal.aborted ? 'the node is shutting down' : String((err as Error)?.message ?? err).replace(/\.+$/, '');
      this.note(model, `failed: ${error}`);
      if (!this.abort.signal.aborted) logger.warn(`⚠️ Could not benchmark ${model}: ${error}. It will be tried again on the next start.`);
      return { model, ok: false, error };
    }
  }

  private async measure(model: string, kind: ModelKind, digest: string | undefined): Promise<BenchmarkResult> {
    logger.info(`📏 Benchmarking ${model} (${kind === 'decision' ? 'response time' : 'time to first token and tokens/s'})…`);
    const samples: { warmth: Warmth; sample: InferenceSample; coldStart?: ColdStartMethod }[] = [];

    const ollama = await this.deps.ollama.isOllama(model);
    // Whether to put the model back out of memory afterwards (plan 020). A sweep
    // that left every model it measured loaded overcommitted unified-memory
    // machines (DGX Spark), where Ollama's free-memory estimate is unreliable.
    // Unknown counts as "was not loaded": the safe side is less memory held.
    const wasLoaded = ollama ? await this.deps.ollama.loaded(model) : undefined;
    if (ollama) this.note(model, `in memory before: ${describeRunning(await this.deps.ollama.running(model))}`);
    else this.note(model, 'backend is not Ollama: no forced cold start, and nothing to unload afterwards');

    try {
      // A cold start is only timed when one can be made to happen: Ollama unloads
      // on request. Elsewhere the first run's warmth is whatever is known about it.
      const forced = ollama && (await this.deps.ollama.unload(model, this.abort.signal));
      if (ollama) this.note(model, forced ? 'unloaded for a cold start' : 'could not confirm an unload; the first run is not a forced cold start');
      const firstWarmth: Warmth = forced ? 'cold' : await this.deps.warmth.before(model);
      const first = await this.timedRun(model, kind, `run 1/${HOT_RUNS + 1} (${firstWarmth})`, forced ? this.coldMs : this.hotMs);
      if (first) samples.push({ warmth: firstWarmth, sample: first, coldStart: forced ? 'forced' : undefined });

      for (let i = 0; i < HOT_RUNS; i++) {
        await this.deps.warmth.before(model);
        const sample = await this.timedRun(model, kind, `run ${i + 2}/${HOT_RUNS + 1} (hot)`, this.hotMs);
        if (sample) samples.push({ warmth: 'hot', sample });
      }
    } finally {
      if (ollama) await this.restoreMemory(model, wasLoaded);
    }
    if (samples.length === 0) throw new Error('the model produced no output');

    this.deps.store.replaceWithBenchmark(model, digest, samples);
    const performance = this.deps.store.performanceFor(model);
    logger.info(`📏 ${model}: ${describePerformance(performance)}`);
    return { model, ok: true, performance };
  }

  /** `once`, with a trace line before (so a crash shows the step it died in) and after. */
  private async timedRun(model: string, kind: ModelKind, label: string, timeoutMs: number): Promise<InferenceSample | null> {
    this.note(model, `${label}: sending (timeout ${Math.round(timeoutMs / 1000)} s)`);
    const started = performance.now();
    try {
      const sample = await this.once(model, kind, timeoutMs);
      this.note(model, `${label}: ${sample ? describeSample(sample, kind) : 'answered without streaming, so it could not be timed'}`);
      return sample;
    } catch (err) {
      this.note(model, `${label}: failed after ${Math.round(performance.now() - started)} ms: ${(err as Error)?.message ?? err}`);
      throw err;
    }
  }

  /**
   * Leave the runtime's memory as the benchmark found it: unload a model that
   * was not loaded before. Not tied to the abort signal, so a benchmark cut
   * short at shutdown still gives the memory back; the unload has its own timeout.
   */
  private async restoreMemory(model: string, wasLoaded: boolean | undefined): Promise<void> {
    if (wasLoaded === true) {
      this.note(model, 'was loaded before, so it stays loaded');
    } else {
      const freed = await this.deps.ollama.unload(model);
      this.note(model, freed ? 'unloaded again, as it was not loaded before' : 'could not confirm it was unloaded again');
    }
    this.note(model, `in memory after: ${describeRunning(await this.deps.ollama.running(model))}`);
  }

  private async once(model: string, kind: ModelKind, timeoutMs: number): Promise<InferenceSample | null> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    if (kind === 'decision') {
      const request = { model, ...BENCHMARK_SYSTEMONE };
      const { body, elapsedMs } = await this.deps.backend.systemOneTimed(request, signal);
      return systemOneSample(elapsedMs, request, body);
    }
    const { completion, timing } = await this.deps.backend.chatTimed(model, BENCHMARK_MESSAGES, BENCHMARK_PARAMS, signal);
    return timing ? toSample(timing, completion, BENCHMARK_MESSAGES, BENCHMARK_PARAMS) : null;
  }
}

/**
 * `cold 2140 ms, hot 85 ms, 54.2 tok/s (forced cold)` — for logs and the CLI.
 * A decision model has no tok/s, so that part is left out when absent.
 */
export function describePerformance(p: ModelPerformance | undefined): string {
  if (!p) return 'no figures yet';
  const parts = [
    `cold ${p.ttftColdMs ? `${p.ttftColdMs.value} ms` : '—'}`,
    `hot ${p.ttftHotMs ? `${p.ttftHotMs.value} ms` : '—'}`,
    ...(p.tokensPerSecond ? [`${p.tokensPerSecond.value} tok/s`] : []),
  ];
  return `${parts.join(', ')}${p.coldStart ? ` (${p.coldStart} cold)` : ''}`;
}

/** Where the figures are kept: beside the peer identity. In memory only without one. */
export function performancePath(): string | undefined {
  const dir = environment.peerIdStorage?.path;
  return dir ? join(resolvePath(dir), 'model-benchmarks.json') : undefined;
}

/** Most model names one `diiisco benchmark` may name; the control channel caps request size. */
export const MAX_BENCHMARK_MODELS = 16;

/**
 * What `diiisco benchmark` does, shared by the daemon (over the control
 * channel) and the CLI's own run when no daemon is up. With `list`, report the
 * figures held; otherwise re-measure the named models, or every served chat
 * and decision model when none are named. A named model that is not served, or
 * is an embedding model, comes back as a failed result rather than an error,
 * so the rest still run.
 */
export async function benchmarkRequest(options: {
  /** Not needed to `list`. */
  benchmarker?: Benchmarker;
  store: PerformanceStore;
  served: ModelInfo[];
  requested: string[];
  list: boolean;
  /** Measure only models with no figures (`--missing`); unused with `list`. */
  missingOnly?: boolean;
  /** Hears each step of the measuring (`--verbose`); unused with `list`. */
  onTrace?: BenchmarkTrace;
}): Promise<BenchmarkResult[]> {
  const { benchmarker, store, served, requested, list, missingOnly, onTrace } = options;
  const measured = served.filter((m) => isMeasured(m.kind));

  if (list) {
    const ids = requested.length > 0 ? requested : [...new Set([...measured.map((m) => m.id), ...store.models()])].sort();
    return ids.map((model) => ({ model, ok: true, performance: store.performanceFor(model) }));
  }

  if (!benchmarker) throw new Error('nothing here can run a benchmark');
  const targets = requested.length > 0 ? requested : measured.map((m) => m.id);
  const results = new Map<string, BenchmarkResult>();
  const runnable: ModelInfo[] = [];
  for (const model of targets) {
    const entry = served.find((m) => m.id === model);
    if (!entry) results.set(model, { model, ok: false, error: 'not served by this node right now' });
    else if (!isMeasured(entry.kind)) results.set(model, { model, ok: false, error: `it is a ${entry.kind} model; only chat and decision models are measured` });
    else runnable.push(entry);
  }
  for (const result of await benchmarker.run(runnable, { onTrace, missingOnly })) results.set(result.model, result);
  return targets.map((model) => results.get(model)!);
}
