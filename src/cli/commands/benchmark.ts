/**
 * `diiisco benchmark [model ...] [--list] [--json] [--verbose]` — re-measure (or, with
 * `--list`, show) each chat model's time to first token and tokens/s, and each
 * decision model's response time (plan 018).
 *
 * With a node running, the node does the work over its control channel, so the
 * run never races its live samples or its writes to `model-benchmarks.json`.
 * With none running, this process measures against the configured backend
 * itself: no libp2p, no wallet.
 *
 * `--verbose` (plan 020) prints each step — what the runtime holds in memory,
 * unloads, every run's timing or failure — on stderr, so it never mixes with
 * `--json`. Standalone the steps print as they happen; a running node sends
 * them back with the results.
 */
import { configureEnvironment } from '../../index';
import { assertValid, loadConfig, requireConfig } from '../config';
import { liveDaemon } from '../daemon';
import { requestBenchmark } from '../control';
import { colour, die, info, json, setQuiet, warn } from '../output';
import { logger, LogLevel } from '../../utils/logger';
import { InferenceBackends, resolveBackends } from '../../utils/backendPool';
import { ModelAvailabilityMonitor } from '../../utils/modelAvailability';
import {
  Benchmarker, MAX_BENCHMARK_MODELS, PerformanceStore, WarmthTracker, benchmarkRequest, performancePath, type BenchmarkResult,
} from '../../utils/modelPerformance';
import { EventEmitter } from 'node:events';
import type { PerformanceFigure } from '../../types/performance';

export interface BenchmarkOptions {
  models: string[];
  list: boolean;
  json: boolean;
  verbose: boolean;
}

/** One trace line, on stderr. */
const printTrace = (line: string) => process.stderr.write(`${colour.dim(line)}\n`);

const fmt = (f: PerformanceFigure | undefined, unit: string) => (f ? `${f.value}${unit} ${colour.dim(`(${f.samples})`)}` : colour.dim('—'));

function printResults(results: BenchmarkResult[], list: boolean): void {
  if (results.length === 0) {
    info(list ? 'No figures yet, and no chat or decision models are being served.' : 'No chat or decision models are being served, so there is nothing to measure.');
    return;
  }
  const width = Math.max(5, ...results.map((r) => r.model.length));
  info(colour.bold(`${'model'.padEnd(width)}  cold TTFT        hot TTFT         tok/s            cold start`));
  for (const r of results) {
    if (!r.ok) {
      info(`${r.model.padEnd(width)}  ${colour.yellow(`failed: ${r.error ?? 'unknown error'}`)}`);
      continue;
    }
    const p = r.performance;
    // Padding is measured without colour codes, so pad the plain text and colour after.
    const cell = (f: PerformanceFigure | undefined, unit: string) => {
      const plain = f ? `${f.value}${unit} (${f.samples})` : '—';
      return fmt(f, unit) + ' '.repeat(Math.max(1, 17 - plain.length));
    };
    info(`${r.model.padEnd(width)}  ${cell(p?.ttftColdMs, ' ms')}${cell(p?.ttftHotMs, ' ms')}${cell(p?.tokensPerSecond, '')}${p?.coldStart ?? colour.dim(p?.ttftColdMs ? '' : 'not measured')}`);
  }
  info(colour.dim('Figures are medians; (n) is the number of samples behind each. Live inference keeps them current.'));
}

/** Measure in this process, for when no node is running. */
async function runStandalone(models: string[], list: boolean, verbose: boolean): Promise<BenchmarkResult[]> {
  requireConfig();
  const env = loadConfig();
  assertValid(env);
  configureEnvironment(env);
  if (!env.models.enabled) throw new Error('this node has no inference backend enabled (models.enabled is false)');
  if (env.models.benchmark?.enabled === false) throw new Error('performance measurement is off (models.benchmark.enabled is false)');

  // This command prints its own output; the node's log lines would only interleave with it.
  logger.setLevel(LogLevel.ERROR);

  const backends = new InferenceBackends(resolveBackends(env.models), new EventEmitter(), { kinds: env.models.kinds });
  const store = new PerformanceStore(performancePath());
  store.load();
  if (list) return benchmarkRequest({ store, served: [], requested: models, list: true });

  const monitor = new ModelAvailabilityMonitor(backends, { enabled: true, checkIntervalMs: 0 });
  await monitor.refresh();
  if (!monitor.isHealthy()) throw new Error(`no inference backend is answering (${backends.describe()})`);

  const benchmarker = new Benchmarker({ backend: backends, store, warmth: new WarmthTracker(backends), ollama: backends });
  try {
    return await benchmarkRequest({ benchmarker, store, served: monitor.models(), requested: models, list: false, onTrace: verbose ? printTrace : undefined });
  } finally {
    store.close();
  }
}

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  if (options.json) setQuiet(true);
  if (options.models.length > MAX_BENCHMARK_MODELS) {
    die(`Name at most ${MAX_BENCHMARK_MODELS} models at a time.`);
  }

  const { state } = liveDaemon();
  let results: BenchmarkResult[];
  try {
    if (state?.control) {
      if (!options.json && !options.list) {
        info(colour.dim('Asking the running node to measure; a cold start can take a minute or more per model…'));
      }
      const verbose = options.verbose && !options.list;
      if (verbose && !options.json) {
        info(colour.dim('The steps print when the node finishes. To follow them live, set node.logLevel to "debug" and run: diiisco logs -f'));
      }
      const answer = await requestBenchmark(state.control.port, state.control.token, options.models, options.list, verbose);
      if (!answer.ok || !answer.value) throw new Error(answer.error ?? 'the node did not answer');
      if (verbose) {
        if (answer.value.trace) answer.value.trace.forEach(printTrace);
        else warn('The running node sent no steps; it is older than this command. Restart it to use --verbose.');
      }
      results = answer.value.results;
    } else {
      if (state && !state.control) {
        die('This daemon did not record a control channel, so it cannot be asked to measure.', 'Restart it with: diiisco restart');
      }
      if (!options.json && !options.list) {
        info(colour.dim('The node is not running; measuring against the configured backend directly…'));
      }
      results = await runStandalone(options.models, options.list, options.verbose && !options.list);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) json({ ok: false, error: message });
    else warn(message);
    process.exitCode = 1;
    return;
  }

  const ok = results.every((r) => r.ok);
  if (options.json) json({ ok, models: results.map(({ model, ok: fine, performance, error }) => ({ model, ok: fine, performance, error })) });
  else printResults(results, options.list);
  if (!ok) process.exitCode = 1;
}
