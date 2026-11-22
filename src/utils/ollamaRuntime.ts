/**
 * The few Ollama-native calls performance measurement needs (plan 018): is the
 * backend Ollama at all, is a model loaded right now, its digest, and unloading
 * it so a cold start can be timed on purpose.
 *
 * DIIISCO fronts any OpenAI-compatible runtime, so none of this may be
 * required: every method is bounded by a timeout, never throws, and answers
 * `undefined` / `false` when the backend does not speak Ollama.
 */

/** How long a runtime that is not Ollama is left alone before being asked again. */
const DIALECT_RETRY_MS = 5 * 60_000;
/** `/api/ps` sits in front of every inference, so it gets very little time. */
const LOADED_TIMEOUT_MS = 250;
const DEFAULT_TIMEOUT_MS = 2_000;
/** Ollama answers an unload at once but frees the model a moment later. */
const UNLOAD_SETTLE_MS = 5_000;
const UNLOAD_POLL_MS = 200;

/** A model Ollama holds in memory (`/api/ps`). */
export interface RunningModel {
  name: string;
  sizeBytes?: number;
  vramBytes?: number;
}

export interface OllamaRuntimeOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export class OllamaRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private dialect: { isOllama: boolean; checkedAt: number } | null = null;

  /** `origin` as from `backendOrigin()`: no trailing slash, no `/v1`. */
  constructor(private readonly origin: string, options: OllamaRuntimeOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Whether the backend is Ollama. A yes is kept for good; a no is re-checked every few minutes. */
  async isOllama(): Promise<boolean> {
    const cached = this.dialect;
    if (cached && (cached.isOllama || this.now() - cached.checkedAt < DIALECT_RETRY_MS)) return cached.isOllama;
    const body = await this.getJson('/api/version', DEFAULT_TIMEOUT_MS);
    const isOllama = typeof body?.version === 'string';
    this.dialect = { isOllama, checkedAt: this.now() };
    return isOllama;
  }

  /** Whether `model` is loaded in memory now; `undefined` when that cannot be told. */
  async loaded(model: string): Promise<boolean | undefined> {
    if (!(await this.isOllama())) return undefined;
    const body = await this.getJson('/api/ps', LOADED_TIMEOUT_MS);
    if (!Array.isArray(body?.models)) return undefined;
    return body.models.some((m: any) => sameModel(m?.name, model) || sameModel(m?.model, model));
  }

  /**
   * Every model Ollama holds in memory now, with its size; `undefined` when that
   * cannot be told. Diagnostics only (the benchmark trace), so it gets the
   * ordinary timeout rather than `loaded`'s tight one.
   */
  async running(): Promise<RunningModel[] | undefined> {
    if (!(await this.isOllama())) return undefined;
    const body = await this.getJson('/api/ps', DEFAULT_TIMEOUT_MS);
    if (!Array.isArray(body?.models)) return undefined;
    return body.models
      .filter((m: any) => typeof (m?.name ?? m?.model) === 'string')
      .map((m: any) => ({
        name: String(m.name ?? m.model),
        sizeBytes: Number.isFinite(m.size) ? m.size : undefined,
        vramBytes: Number.isFinite(m.size_vram) ? m.size_vram : undefined,
      }));
  }

  /** The model's content digest, which changes when the model is re-pulled or replaced. */
  async digest(model: string): Promise<string | undefined> {
    if (!(await this.isOllama())) return undefined;
    const body = await this.getJson('/api/tags', DEFAULT_TIMEOUT_MS);
    if (!Array.isArray(body?.models)) return undefined;
    const entry = body.models.find((m: any) => sameModel(m?.name, model) || sameModel(m?.model, model));
    return typeof entry?.digest === 'string' ? entry.digest : undefined;
  }

  /**
   * Unload `model` and wait until Ollama no longer lists it as loaded. True only
   * once that is confirmed, so a cold start timed afterwards really is one.
   */
  async unload(model: string, signal?: AbortSignal): Promise<boolean> {
    if (!(await this.isOllama())) return false;
    try {
      const response = await this.fetchImpl(`${this.origin}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: withTimeout(signal, DEFAULT_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) return false;
    } catch {
      return false;
    }

    const deadline = this.now() + UNLOAD_SETTLE_MS;
    while (this.now() < deadline) {
      if (signal?.aborted) return false;
      if ((await this.loaded(model)) === false) return true;
      await new Promise((resolve) => setTimeout(resolve, UNLOAD_POLL_MS));
    }
    return false;
  }

  private async getJson(path: string, timeoutMs: number): Promise<any | undefined> {
    try {
      const response = await this.fetchImpl(`${this.origin}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }
      return await response.json();
    } catch {
      return undefined;
    }
  }
}

/** Ollama treats `llama3.2` and `llama3.2:latest` as the same model. */
function sameModel(candidate: unknown, model: string): boolean {
  if (typeof candidate !== 'string') return false;
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return norm(candidate) === norm(model);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
