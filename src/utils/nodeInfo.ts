/**
 * Shape checks for what a node says about itself: its tags, and (see
 * `parsePerformance`) its per-model performance figures. These arrive in quotes
 * and in profiles from strangers, so every parser here is pure, never throws,
 * and copies through only the fields it checked. They prove shape and bounds,
 * not truth: the figures are the sender's own claims.
 */

import { COLD_START_METHODS, type ColdStartMethod, type ModelPerformance, type PerformanceFigure } from '../types/performance';

/** Lowercase letters, digits and hyphens, starting with a letter or digit, at most 48 characters. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_TAGS = 16;

/**
 * A clean copy of a tag list, or `undefined` if `value` is not one: not an
 * array, more than `MAX_TAGS`, a tag that does not match `TAG_PATTERN`, or a
 * duplicate.
 */
export function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TAGS) return undefined;
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag) || seen.has(tag)) return undefined;
    seen.add(tag);
  }
  return [...seen];
}

/** Why a configured tag list is invalid, phrased for `validateEnvironment`, or `null` if it is fine. */
export function tagsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return '`node.tags` must be a list of strings, e.g. ["cuda", "nvidia-dgx-spark"].';
  if (value.length > MAX_TAGS) return `\`node.tags\` may hold at most ${MAX_TAGS} tags (got ${value.length}).`;
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
      return `\`node.tags\` entry ${JSON.stringify(tag)} is not a valid tag: use lowercase letters, digits and hyphens, starting with a letter or digit, at most 48 characters (e.g. "apple-silicon-m4-pro").`;
    }
    if (seen.has(tag)) return `\`node.tags\` lists "${tag}" more than once.`;
    seen.add(tag);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

const MAX_TTFT_MS = 600_000;
const MAX_TOKENS_PER_SECOND = 100_000;
const MAX_SAMPLES = 1_000_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A figure, `undefined` when absent, or `null` when present but malformed. */
function parseFigure(value: unknown, max: number): PerformanceFigure | undefined | null {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  const { value: v, samples } = value;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) return null;
  if (typeof samples !== 'number' || !Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) return null;
  return { value: v, samples };
}

/**
 * A clean copy of a performance block, or `undefined` if `value` is not one.
 * Any present field that is malformed or out of bounds rejects the whole block:
 * a half-believed claim is worse than none. Unknown keys are not copied.
 */
export function parsePerformance(value: unknown): ModelPerformance | undefined {
  if (!isObject(value)) return undefined;
  const { updatedAt, coldStart } = value;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return undefined;
  if (coldStart !== undefined && !COLD_START_METHODS.includes(coldStart as ColdStartMethod)) return undefined;

  const ttftColdMs = parseFigure(value.ttftColdMs, MAX_TTFT_MS);
  const ttftHotMs = parseFigure(value.ttftHotMs, MAX_TTFT_MS);
  const tokensPerSecond = parseFigure(value.tokensPerSecond, MAX_TOKENS_PER_SECOND);
  if (ttftColdMs === null || ttftHotMs === null || tokensPerSecond === null) return undefined;

  return {
    ...(ttftColdMs ? { ttftColdMs } : {}),
    ...(ttftHotMs ? { ttftHotMs } : {}),
    ...(tokensPerSecond ? { tokensPerSecond } : {}),
    updatedAt,
    ...(coldStart ? { coldStart: coldStart as ColdStartMethod } : {}),
  };
}
