import type { ModelKind } from './models';

/**
 * How fast a node serves one model, as the node itself measured it (plan 018).
 * Carried in quotes and on the status pages. Self-reported: a receiver can
 * check the shape (`parsePerformance`), not the truth.
 */

/** One figure: the median of its recent samples, and how many samples that is. */
export interface PerformanceFigure {
  value: number;
  samples: number;
}

/**
 * How the cold-start figure was obtained: `forced` — the node unloaded the
 * model itself and timed the reload (Ollama); `observed` — a real request found
 * the model unloaded.
 */
export type ColdStartMethod = 'forced' | 'observed';

export const COLD_START_METHODS: readonly ColdStartMethod[] = ['forced', 'observed'];

export interface ModelPerformance {
  /** Time to first token with the model not yet loaded. Absent until a cold sample exists. */
  ttftColdMs?: PerformanceFigure;
  /** Time to first token with the model already loaded. */
  ttftHotMs?: PerformanceFigure;
  /** Decode rate: output tokens per second after the first. */
  tokensPerSecond?: PerformanceFigure;
  /** Epoch ms of the newest sample behind any figure. */
  updatedAt: number;
  coldStart?: ColdStartMethod;
}

/**
 * The kinds that get figures. A decision model answers in one piece, so its
 * time-to-first-token figures hold the whole response time and it has no
 * tokens/s; an embedding is not measured.
 */
export const MEASURED_KINDS: readonly ModelKind[] = ['chat', 'decision'];
export const isMeasured = (kind: ModelKind | undefined): boolean => MEASURED_KINDS.includes(kind ?? 'chat');
