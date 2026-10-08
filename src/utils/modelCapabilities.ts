import type { Model } from 'openai/resources/index';
import { MODEL_KINDS, type ModelInfo, type ModelKind } from '../types/models';
import { logger } from './logger';

/**
 * Working out what kind of model each served model is.
 *
 * `/v1/models` carries no type, and a provider can front **any** OpenAI-
 * compatible runtime — Ollama, LM Studio, vLLM, llama.cpp, LiteLLM, a hosted
 * endpoint — so nothing here assumes one. Detection is a pipeline of
 * `KindSource`s tried in precedence order; the first source with an opinion
 * about a model wins, and a model nobody has an opinion about is `chat`.
 *
 *   1. the operator's `models.kinds` override  (authoritative, any runtime)
 *   2. what the `/v1/models` entry says about itself  (no extra request)
 *   3. a runtime's own listing — Ollama, LM Studio  (one request each)
 *   4. a name heuristic  (a guess, last resort)
 *   5. `chat`
 *
 * Detection **fails open**, the opposite of availability: a model we cannot
 * classify is still offered rather than hidden, and no failure here can mark
 * the backend unhealthy.
 */

/** What a source concluded about one model. */
export interface Classification {
  kind: ModelKind;
  /** The raw capability strings, when the source had them. */
  capabilities?: string[];
}

export interface KindContext {
  /** Backend origin, e.g. `http://localhost:11434` (no trailing slash, no `/v1`). */
  origin: string;
  /** Aborts when the detection budget is spent. */
  signal: AbortSignal;
  fetch: typeof fetch;
}

export interface KindSource {
  name: string;
  /**
   * True for sources that make a request of their own. When one reports "no
   * data" (this runtime does not speak that dialect) it is skipped for a while
   * instead of being asked again on every poll.
   */
  probesBackend?: boolean;
  /**
   * Classify some of `pending`. Return `null` for "no opinion" and leave out
   * the models you know nothing about. A *thrown* error means "transient" —
   * the source is simply tried again next time.
   */
  detect(ctx: KindContext, pending: Model[]): Promise<Map<string, Classification> | null>;
}

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

/**
 * Capability strings → kind. **Decision wins over completion**: Ollama lists
 * `completion` on its decision models too, and a chat call on one succeeds but
 * returns only a `reasoning` field. An embedding model is one that can embed
 * and cannot complete.
 */
export function kindFromCapabilities(capabilities: readonly string[]): ModelKind | null {
  const caps = new Set(capabilities.map((c) => String(c).toLowerCase()));
  if (caps.has('decision') || caps.has('systemone')) return 'decision';

  const embeds = caps.has('embedding') || caps.has('embeddings');
  const generates = ['completion', 'completions', 'chat', 'generate', 'tools', 'vision', 'thinking'].some((c) => caps.has(c));
  if (generates) return 'chat';
  if (embeds) return 'embedding';
  return null;
}

/** A single type-ish string (`"embeddings"`, `"llm"`, `"decision"`) → kind. */
export function kindFromTypeString(raw: unknown): ModelKind | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (value.includes('embed')) return 'embedding';
  if (value.includes('decision') || value === 'systemone') return 'decision';
  if (['chat', 'llm', 'vlm', 'text', 'text-generation', 'completion', 'completions', 'generate'].includes(value)) return 'chat';
  // `rerank`, `image`, `audio`, … are real model types that DIIISCO has no kind
  // for. No opinion, rather than a wrong one.
  return null;
}

/** Fields servers put on their own `/v1/models` entries, tried in this order. */
const SELF_DESCRIBING_STRING_FIELDS = ['kind', 'type', 'mode', 'task', 'model_type'] as const;

/**
 * What a `/v1/models` entry says about itself. Costs no request, and covers
 * servers that already tag their models (LiteLLM, OpenRouter-style gateways) as
 * well as any runtime that starts to.
 */
export function kindFromEntry(entry: Record<string, any>): Classification | null {
  if (Array.isArray(entry.capabilities)) {
    const kind = kindFromCapabilities(entry.capabilities);
    if (kind) return { kind, capabilities: entry.capabilities.map(String) };
  }

  for (const field of SELF_DESCRIBING_STRING_FIELDS) {
    const kind = kindFromTypeString(entry[field]);
    if (kind) return { kind };
  }

  const outputs = entry.output_modalities ?? entry.architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.some((m: unknown) => String(m).toLowerCase().includes('embed'))) {
    return { kind: 'embedding' };
  }
  return null;
}

/**
 * A guess from the model's name, used only when nothing better had an opinion.
 * Embedding models are conventionally named for what they are; decision models
 * are not (a name like `tev1` says nothing), which is why `decision` is never
 * guessed here — set it with `models.kinds`.
 */
const EMBEDDING_NAME_HINTS = /embed|(^|[/:_-])(bge|e5|gte|minilm)([/:_.\d-]|$)/i;

export function kindFromName(id: string): ModelKind | null {
  return EMBEDDING_NAME_HINTS.test(id) ? 'embedding' : null;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** `models.kinds`: exact ids win over globs (`*` only), which are tried in config order. */
export function overrideSource(overrides: Record<string, ModelKind> | undefined): KindSource {
  const exact = new Map<string, ModelKind>();
  const globs: Array<{ pattern: RegExp; kind: ModelKind }> = [];
  for (const [key, kind] of Object.entries(overrides ?? {})) {
    if (!MODEL_KINDS.includes(kind)) continue;
    if (key.includes('*')) {
      const source = key.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      globs.push({ pattern: new RegExp(`^${source}$`, 'i'), kind });
    } else {
      exact.set(key.toLowerCase(), kind);
    }
  }

  return {
    name: 'override',
    async detect(_ctx, pending) {
      const found = new Map<string, Classification>();
      for (const { id } of pending) {
        const direct = exact.get(id.toLowerCase());
        const kind = direct ?? globs.find((g) => g.pattern.test(id))?.kind;
        if (kind) found.set(id, { kind });
      }
      return found.size > 0 ? found : null;
    },
  };
}

export const selfDescribedSource: KindSource = {
  name: 'self-described',
  async detect(_ctx, pending) {
    const found = new Map<string, Classification>();
    for (const entry of pending) {
      const result = kindFromEntry(entry as Record<string, any>);
      if (result) found.set(entry.id, result);
    }
    return found.size > 0 ? found : null;
  },
};

async function getJson(ctx: KindContext, path: string): Promise<any | null> {
  const response = await ctx.fetch(`${ctx.origin}${path}`, { signal: ctx.signal, headers: { accept: 'application/json' } });
  // A 404 is how a runtime says "that is not my API": no opinion, not an error.
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Ollama's native `GET /api/tags`, which — unlike its `/v1/models` — lists each
 * model's `capabilities` (`embedding`, `completion`, `decision`, …).
 */
export const ollamaSource: KindSource = {
  name: 'ollama',
  probesBackend: true,
  async detect(ctx, pending) {
    const body = await getJson(ctx, '/api/tags');
    if (!Array.isArray(body?.models)) return null;

    const wanted = new Set(pending.map((m) => m.id));
    const found = new Map<string, Classification>();
    for (const m of body.models) {
      const id = String(m?.name ?? m?.model ?? '');
      if (!wanted.has(id)) continue;

      if (Array.isArray(m.capabilities)) {
        const kind = kindFromCapabilities(m.capabilities);
        if (kind) found.set(id, { kind, capabilities: m.capabilities.map(String) });
      } else {
        // Ollama before it reported capabilities: the BERT family is embedding-only.
        const families = [m?.details?.family, ...(Array.isArray(m?.details?.families) ? m.details.families : [])];
        if (families.some((f) => /bert/i.test(String(f ?? '')))) found.set(id, { kind: 'embedding' });
      }
    }
    return found.size > 0 ? found : null;
  },
};

/** LM Studio's `GET /api/v0/models`, whose entries carry `type: llm | vlm | embeddings`. */
export const lmStudioSource: KindSource = {
  name: 'lm-studio',
  probesBackend: true,
  async detect(ctx, pending) {
    const body = await getJson(ctx, '/api/v0/models');
    if (!Array.isArray(body?.data)) return null;

    const wanted = new Set(pending.map((m) => m.id));
    const found = new Map<string, Classification>();
    for (const m of body.data) {
      const id = String(m?.id ?? '');
      if (!wanted.has(id)) continue;
      const kind = kindFromTypeString(m?.type);
      if (kind) found.set(id, { kind });
    }
    return found.size > 0 ? found : null;
  },
};

export const nameHeuristicSource: KindSource = {
  name: 'name-heuristic',
  async detect(_ctx, pending) {
    const found = new Map<string, Classification>();
    for (const { id } of pending) {
      const kind = kindFromName(id);
      if (kind) found.set(id, { kind });
    }
    return found.size > 0 ? found : null;
  },
};

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** How long a backend-probing source that found nothing is left alone. */
const DIALECT_RETRY_MS = 5 * 60_000;
/** How long a model nobody could classify is assumed to be `chat` before asking again. */
const UNKNOWN_RETRY_MS = 60_000;

export interface ModelKindDetectorOptions {
  /** `models.baseURL`, e.g. `http://localhost`. */
  baseURL: string;
  /** `models.port`. */
  port: number;
  /** `models.kinds`. */
  overrides?: Record<string, ModelKind>;
  /** Replace the source list (tests, or a runtime this build does not know). */
  sources?: KindSource[];
  fetch?: typeof fetch;
  now?: () => number;
}

interface CacheEntry {
  classification: Classification | null;
  /** `null` → until the model itself changes. */
  expiresAt: number | null;
}

/**
 * Classifies models and remembers the answers, so the availability poll costs
 * no extra request while the model list is unchanged.
 */
export class ModelKindDetector {
  private readonly origin: string;
  private readonly overrides: KindSource;
  private readonly sources: KindSource[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly skipUntil = new Map<string, number>();

  constructor(options: ModelKindDetectorOptions) {
    this.origin = `${options.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')}:${options.port}`;
    this.overrides = overrideSource(options.overrides);
    this.sources = options.sources ?? [selfDescribedSource, ollamaSource, lmStudioSource, nameHeuristicSource];
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Tag each model with its kind. Never throws; on any failure the affected
   * models come back as `chat`.
   *
   * `timeoutMs` bounds the *whole* call, so a hung runtime cannot hold up the
   * availability probe that is waiting on this.
   */
  async classify(models: Model[], timeoutMs: number): Promise<ModelInfo[]> {
    const signal = AbortSignal.timeout(timeoutMs);
    const ctx: KindContext = { origin: this.origin, signal, fetch: this.fetchImpl };
    const resolved = new Map<string, Classification | null>();
    let pending: Model[] = [];

    // The override is configuration, so it is applied fresh rather than cached.
    const overridden = (await this.overrides.detect(ctx, models)) ?? new Map<string, Classification>();
    for (const model of models) {
      const override = overridden.get(model.id);
      if (override) {
        resolved.set(model.id, override);
        continue;
      }
      const cached = this.cache.get(this.keyOf(model));
      if (cached && (cached.expiresAt === null || cached.expiresAt > this.now())) {
        resolved.set(model.id, cached.classification);
      } else {
        pending.push(model);
      }
    }

    if (pending.length > 0) {
      const { found, incomplete } = await this.runSources(ctx, pending);
      for (const model of pending) {
        const classification = found.get(model.id) ?? null;
        resolved.set(model.id, classification);
        this.cache.set(this.keyOf(model), {
          classification,
          // A source that failed may simply have had a bad moment: ask again
          // next time. One that answered and had nothing to say is remembered.
          expiresAt: classification ? null : incomplete ? 0 : this.now() + UNKNOWN_RETRY_MS,
        });
      }
    }

    // Drop answers for models that are gone so the cache cannot grow forever.
    const live = new Set(models.map((m) => this.keyOf(m)));
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);

    return models.map((model) => {
      const classification = resolved.get(model.id);
      return {
        ...model,
        kind: classification?.kind ?? 'chat',
        ...(classification?.capabilities ? { capabilities: classification.capabilities } : {}),
      };
    });
  }

  private async runSources(
    ctx: KindContext,
    models: Model[]
  ): Promise<{ found: Map<string, Classification>; incomplete: boolean }> {
    const found = new Map<string, Classification>();
    let pending = models;
    let incomplete = false;

    for (const source of this.sources) {
      if (pending.length === 0) break;
      if (source.probesBackend && (this.skipUntil.get(source.name) ?? 0) > this.now()) continue;

      try {
        const result = await source.detect(ctx, pending);
        if (result === null || result.size === 0) {
          if (source.probesBackend) this.skipUntil.set(source.name, this.now() + DIALECT_RETRY_MS);
          continue;
        }
        this.skipUntil.delete(source.name);
        for (const [id, classification] of result) found.set(id, classification);
        pending = pending.filter((m) => !found.has(m.id));
      } catch (err) {
        // Transient (timeout, connection reset): try again next time, do not back off.
        incomplete = true;
        logger.debug(`Model kind source "${source.name}" failed: ${(err as Error).message}`);
      }
    }
    return { found, incomplete };
  }

  /** `created` changes when a model is re-pulled, so a replaced model is re-classified. */
  private keyOf(model: Model): string {
    return `${model.id}\u0000${model.created ?? ''}`;
  }
}

// ---------------------------------------------------------------------------
// Reading kinds off listings (the API and the launcher)
// ---------------------------------------------------------------------------

/** A kind from anywhere untrusted (a peer's listing): unknown or absent reads as `chat`. */
export function normalizeKind(value: unknown): ModelKind {
  return MODEL_KINDS.includes(value as ModelKind) ? (value as ModelKind) : 'chat';
}

export type KindFilter = ModelKind | 'all';

/** `?type=` on `/v1/models`. `undefined` (absent) is `chat`; an unrecognised value is `null`. */
export function parseKindFilter(raw: unknown): KindFilter | null {
  if (raw === undefined || raw === '') return 'chat';
  if (typeof raw !== 'string') return null;
  const value = raw.toLowerCase();
  return value === 'all' || MODEL_KINDS.includes(value as ModelKind) ? (value as KindFilter) : null;
}

export function filterModelsByKind<T extends { kind?: unknown }>(models: T[], filter: KindFilter): T[] {
  if (filter === 'all') return models;
  return models.filter((m) => normalizeKind(m.kind) === filter);
}
