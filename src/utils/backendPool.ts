/**
 * Several inference runtimes behind one node (plan 019).
 *
 * The node used to front exactly one OpenAI-compatible backend. The pool keeps
 * that backend's interface (`getResponse`, `systemOne`, `getModels`, …) and
 * routes each call to the runtime that serves the model:
 *
 *  - every availability probe asks each backend for its models, in parallel,
 *    classifying them with that backend's own kind detector;
 *  - a model goes to the **first backend listed** that served it on the last
 *    probe, so when that one goes down the next one that has it takes over;
 *  - one backend down removes only its models. The probe fails (and the node
 *    stops quoting) only when every backend is down.
 *
 * Backend names and addresses stay on this node: nothing here reaches a peer.
 */
import type EventEmitter from 'events';
import type { Model } from 'openai/resources/index';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { BackendConfig, ModelsConfig } from '../environment/environment.types';
import type { ModelInfo, ModelKind } from '../types/models';
import { logger } from './logger';
import { backendOrigin, ModelKindDetector } from './modelCapabilities';
import { countInputTokens, OpenAIInferenceModel, type GenerationParams, type InferenceObserver } from './models';
import { OllamaRuntime, type RunningModel } from './ollamaRuntime';
import type { SystemOneRequest } from './systemOne';

export const MAX_BACKENDS = 16;
const MAX_NAME_LENGTH = 48;

export interface BackendEndpoint {
  name: string;
  baseURL: string;
  port: number;
  apiKey: string;
}

const defaultName = (baseURL: string, port: number): string => {
  try {
    return `${new URL(baseURL).hostname}:${port}`;
  } catch {
    return `${baseURL}:${port}`;
  }
};

/** The configured backends: `models.backends`, or the single-backend fields as one. */
export function resolveBackends(models: ModelsConfig): BackendEndpoint[] {
  const list: BackendConfig[] = models.backends && models.backends.length > 0
    ? models.backends
    : [{ baseURL: models.baseURL ?? 'http://localhost', port: models.port ?? 11434, apiKey: models.apiKey }];
  return list.map((b) => ({
    name: b.name?.trim() || defaultName(b.baseURL, b.port),
    baseURL: b.baseURL.replace(/\/+$/, ''),
    port: b.port,
    apiKey: b.apiKey ?? '',
  }));
}

/** What is wrong with `models.backends`, as messages for `validateEnvironment`. */
export function backendsProblems(backends: unknown): string[] {
  if (!Array.isArray(backends)) return ['`models.backends` must be a list of `{ "baseURL", "port" }` objects.'];
  if (backends.length === 0) return ['`models.backends` is empty. List at least one backend, or remove it and use `models.baseURL` and `models.port`.'];
  if (backends.length > MAX_BACKENDS) return [`\`models.backends\` lists ${backends.length} backends; the most allowed is ${MAX_BACKENDS}.`];

  const errors: string[] = [];
  const names = new Set<string>();
  const origins = new Set<string>();
  backends.forEach((b: any, i) => {
    const field = (name?: string) => `\`models.backends[${i}]${name ? `.${name}` : ''}\``;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      errors.push(`${field()} must be an object with \`baseURL\` and \`port\`.`);
      return;
    }
    let urlOk = false;
    if (typeof b.baseURL !== 'string' || b.baseURL.trim() === '') {
      errors.push(`${field('baseURL')} is missing. Use e.g. "http://localhost".`);
    } else {
      try {
        const url = new URL(b.baseURL);
        urlOk = url.protocol === 'http:' || url.protocol === 'https:';
      } catch { /* reported below */ }
      if (!urlOk) errors.push(`${field('baseURL')} must be an http:// or https:// address (got ${JSON.stringify(b.baseURL)}).`);
    }
    const portOk = Number.isInteger(b.port) && b.port > 0 && b.port <= 65535;
    if (!portOk) errors.push(`${field('port')} must be a port number between 1 and 65535 (got ${JSON.stringify(b.port)}).`);
    if (b.apiKey !== undefined && typeof b.apiKey !== 'string') errors.push(`${field('apiKey')} must be a string.`);
    if (b.name !== undefined && (typeof b.name !== 'string' || b.name.trim() === '' || b.name.length > MAX_NAME_LENGTH)) {
      errors.push(`${field('name')} must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`);
    }

    if (urlOk && portOk) {
      const origin = backendOrigin(b.baseURL, b.port);
      if (origins.has(origin)) {
        errors.push(`${field()}: ${origin} is listed twice.`);
        return;
      }
      origins.add(origin);
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : defaultName(b.baseURL, b.port);
      if (names.has(name)) errors.push(`${field('name')}: "${name}" is used by another backend.`);
      names.add(name);
    }
  });
  return errors;
}

/** One runtime and the helpers that speak to it. */
interface Member {
  endpoint: BackendEndpoint;
  model: OpenAIInferenceModel;
  ollama: OllamaRuntime;
  detector: ModelKindDetector;
  /** `null` until first probed. */
  up: boolean | null;
}

export interface InferenceBackendsOptions {
  /** `models.kinds`, applied by every backend's detector. */
  kinds?: Record<string, ModelKind>;
}

export class InferenceBackends {
  private readonly members: Member[];
  /** model id → the backend that serves it, rebuilt by every probe. */
  private routes = new Map<string, Member>();
  private sharedSummary = '';

  constructor(endpoints: BackendEndpoint[], nodeEvents: EventEmitter, options: InferenceBackendsOptions = {}) {
    if (endpoints.length === 0) throw new Error('at least one model backend is needed');
    this.members = endpoints.map((endpoint) => ({
      endpoint,
      model: new OpenAIInferenceModel(`${endpoint.baseURL}:${endpoint.port}/v1`, nodeEvents, endpoint.apiKey),
      ollama: new OllamaRuntime(backendOrigin(endpoint.baseURL, endpoint.port)),
      detector: new ModelKindDetector({ baseURL: endpoint.baseURL, port: endpoint.port, overrides: options.kinds }),
      up: null,
    }));
  }

  /** `name (http://host:port)` for each backend, for messages. */
  describe(): string {
    return this.members.map((m) => `${m.endpoint.name} (${m.endpoint.baseURL}:${m.endpoint.port})`).join(', ');
  }

  /** Which backend serves `model` right now, by name; for logs and tests. */
  backendFor(model: string): string | undefined {
    return this.routes.get(model)?.endpoint.name;
  }

  set observer(observer: InferenceObserver | undefined) {
    for (const m of this.members) m.model.observer = observer;
  }

  /**
   * Ask every backend for its models. Resolves with the merged list (each id
   * once, as the first backend listed reported it) and re-routes every model;
   * rejects only when no backend answered. `signal` bounds the whole probe.
   */
  async getModels(signal?: AbortSignal, timeoutMs = 2_000): Promise<ModelInfo[]> {
    const results = await Promise.allSettled(this.members.map(async (member) => {
      const listed = (await member.model.getModels(signal)) as Model[];
      return member.detector.classify(listed.filter((m) => m.object === 'model'), timeoutMs);
    }));

    const routes = new Map<string, Member>();
    const merged: ModelInfo[] = [];
    const shared: string[] = [];
    const failures: string[] = [];
    results.forEach((result, i) => {
      const member = this.members[i];
      this.noteHealth(member, result);
      if (result.status === 'rejected') {
        failures.push(`${member.endpoint.name}: ${(result.reason as Error)?.message ?? result.reason}`);
        return;
      }
      for (const model of result.value) {
        const first = routes.get(model.id);
        if (first) {
          shared.push(`${model.id} (${first.endpoint.name}, then ${member.endpoint.name})`);
          continue;
        }
        routes.set(model.id, member);
        merged.push(model);
      }
    });

    if (failures.length === this.members.length) {
      // The one-backend message stays what it always was.
      if (this.members.length === 1) throw (results[0] as PromiseRejectedResult).reason;
      throw new Error(`no model backend answered (${failures.join('; ')})`);
    }

    this.routes = routes;
    const summary = shared.sort().join(', ');
    if (summary !== this.sharedSummary) {
      this.sharedSummary = summary;
      if (summary) logger.info(`🔀 Served by more than one backend, first listed first: ${summary}`);
    }
    return merged;
  }

  // ---- Routed inference ------------------------------------------------------

  async getResponse(model: string, messages: ChatCompletionMessageParam[], params?: GenerationParams) {
    return this.route(model).model.getResponse(model, messages, params);
  }

  async chatTimed(model: string, messages: ChatCompletionMessageParam[], params?: GenerationParams, signal?: AbortSignal) {
    return this.route(model).model.chatTimed(model, messages, params, signal);
  }

  async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<any> {
    return this.route(request.model).model.systemOne(request, signal);
  }

  async systemOneTimed(request: SystemOneRequest, signal?: AbortSignal) {
    return this.route(request.model).model.systemOneTimed(request, signal);
  }

  /** Counted locally, as by a single backend: no runtime is asked. */
  async countEmbeddings(_model: string, inputs: any[], tools?: any[]) {
    return countInputTokens(inputs, tools);
  }

  // ---- Routed runtime probes (performance) -----------------------------------

  async isOllama(model: string): Promise<boolean> {
    return (await this.routes.get(model)?.ollama.isOllama()) ?? false;
  }

  async loaded(model: string): Promise<boolean | undefined> {
    return this.routes.get(model)?.ollama.loaded(model);
  }

  async digest(model: string): Promise<string | undefined> {
    return this.routes.get(model)?.ollama.digest(model);
  }

  async unload(model: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.routes.get(model)?.ollama.unload(model, signal)) ?? false;
  }

  /** What the runtime serving `model` holds in memory (benchmark trace). */
  async running(model: string): Promise<RunningModel[] | undefined> {
    return this.routes.get(model)?.ollama.running();
  }

  private route(model: string): Member {
    const member = this.routes.get(model);
    if (!member) throw new Error(`no model backend serves "${model}" right now`);
    return member;
  }

  /** Log a backend going down or coming back; only meaningful with more than one. */
  private noteHealth(member: Member, result: PromiseSettledResult<unknown>): void {
    const up = result.status === 'fulfilled';
    const was = member.up;
    member.up = up;
    if (this.members.length === 1 || was === up) return;
    const where = `${member.endpoint.name} (${member.endpoint.baseURL}:${member.endpoint.port})`;
    if (!up) {
      const reason = (result as PromiseRejectedResult).reason;
      logger.warn(`⚠️ Model backend ${where} is unreachable; its models are no longer offered (${reason?.message ?? reason})`);
    } else if (was === false) {
      logger.info(`✅ Model backend ${where} is reachable again`);
    }
  }
}
