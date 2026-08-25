import type { Model } from "openai/resources/index";
import environment from "../environment/runtime";
import { OpenAIInferenceModel } from "./models";
import { logger } from "./logger";

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_FRESH_FOR_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * The live set of models this node can actually serve *right now*.
 *
 * A node used to compile its model list once at startup and trust it forever,
 * so stopping the inference backend left it quoting for — and winning auctions
 * for — models it could no longer run, and the requester hung waiting for an
 * answer that was never coming. Every consumer of the old startup snapshot
 * takes this interface instead.
 */
export interface ModelAvailability {
  /** Live model ids. Empty while the backend is unreachable or models are disabled. */
  list(): string[];
  /** Live model objects, for the `list-models` reply. */
  models(): Model[];
  /** Cached, synchronous. Never touches the backend. */
  isAvailable(id: string): boolean;
  /** Re-probe first if the snapshot is stale, then answer. Used on the quote path. */
  ensureAvailable(id: string): Promise<boolean>;
  /** Probe the backend now (single-flight). Resolves to the new id set; never rejects. */
  refresh(): Promise<string[]>;
  /** Whether the last probe succeeded. */
  isHealthy(): boolean;
  /** Mark the snapshot stale so the next `ensureAvailable` re-probes. */
  invalidate(): void;
  start(): void;
  stop(): void;
}

export interface ModelAvailabilityOptions {
  enabled?: boolean;
  checkIntervalMs?: number;
  freshForMs?: number;
  timeoutMs?: number;
}

/**
 * Keeps the served-model set honest by re-probing the backend's `/v1/models`.
 *
 * Two mechanisms, deliberately both:
 *
 *  - a background poll (`checkIntervalMs`) so the status pages, the public
 *    profile and `list-models` replies stop advertising a dead backend without
 *    anyone having to ask; and
 *  - a staleness-triggered probe on the quote path (`freshForMs`), so a
 *    `quote-request` is never answered from a snapshot old enough to be wrong.
 *
 * Probes are single-flight, so a burst of quote-requests costs one backend
 * call, and they fail **closed**: one failed probe empties the set and the node
 * stops quoting. Losing an auction for one poll interval is cheap; winning one
 * with a dead backend is the bug this exists to fix.
 */
export class ModelAvailabilityMonitor implements ModelAvailability {
  private readonly backend: OpenAIInferenceModel;
  private readonly enabled: boolean;
  private readonly checkIntervalMs: number;
  private readonly freshForMs: number;
  private readonly timeoutMs: number;

  private current: Model[] = [];
  private ids: Set<string> = new Set();
  private healthy = false;
  private checkedAt = 0;
  private inFlight: Promise<string[]> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(backend: OpenAIInferenceModel, options: ModelAvailabilityOptions = {}) {
    const configured = environment.models?.availability ?? {};
    this.backend = backend;
    this.enabled = options.enabled ?? environment.models?.enabled ?? false;
    this.checkIntervalMs = options.checkIntervalMs ?? configured.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.freshForMs = options.freshForMs ?? configured.freshForMs ?? DEFAULT_FRESH_FOR_MS;
    this.timeoutMs = options.timeoutMs ?? configured.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  list(): string[] {
    return [...this.ids];
  }

  models(): Model[] {
    return this.current;
  }

  isAvailable(id: string): boolean {
    return this.ids.has(id);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async ensureAvailable(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.isStale()) await this.refresh();
    return this.ids.has(id);
  }

  /** Never probed yet, or the snapshot has aged past `freshForMs`. */
  private isStale(): boolean {
    return this.checkedAt === 0 || Date.now() - this.checkedAt > this.freshForMs;
  }

  invalidate(): void {
    this.checkedAt = 0;
  }

  async refresh(): Promise<string[]> {
    if (!this.enabled) {
      this.applyFailure();
      return [];
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.probe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async probe(): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const models = await this.backend.getModels(controller.signal);
      this.applySuccess(models.filter((m) => m.object === 'model'));
      return [...this.ids];
    } catch (err) {
      this.applyFailure(err as Error);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private applySuccess(models: Model[]): void {
    const next = new Set(models.map((m) => m.id));
    const wasHealthy = this.healthy;
    const previous = this.ids;

    this.current = models;
    this.ids = next;
    this.healthy = true;
    this.checkedAt = Date.now();

    // Log transitions only — a healthy poll every 30s must not fill the log.
    if (!wasHealthy) {
      logger.info(`✅ Inference backend reachable — serving ${next.size} model(s): ${[...next].join(', ') || 'none'}`);
      return;
    }

    const added = [...next].filter((id) => !previous.has(id));
    const removed = [...previous].filter((id) => !next.has(id));
    if (added.length || removed.length) {
      const parts = [
        ...added.map((id) => `+${id}`),
        ...removed.map((id) => `-${id}`),
      ];
      logger.info(`🤖 Model list changed: ${parts.join(', ')}`);
    }
  }

  private applyFailure(err?: Error): void {
    const wasHealthy = this.healthy;
    this.current = [];
    this.ids = new Set();
    this.healthy = false;
    this.checkedAt = Date.now();

    if (wasHealthy) {
      const endpoint = `${environment.models?.baseURL}:${environment.models?.port}`;
      logger.warn(`⚠️ Inference backend at ${endpoint} is unreachable — this node has stopped quoting${err ? ` (${err.message})` : ''}`);
    }
  }

  start(): void {
    if (!this.enabled || this.checkIntervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.checkIntervalMs);
    // Never hold the process open on the poll alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
