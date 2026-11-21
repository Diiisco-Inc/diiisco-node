import OpenAI from "openai";
import environment from "../environment/runtime";
import tokenizer from "llama-tokenizer-js";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import { logger } from './logger';
import EventEmitter from "events";
import { BackendRejectedError, countSystemOneInputTokens, type SystemOneRequest } from "./systemOne";

/**
 * Optional generation params forwarded to the backend chat/completions call.
 * Kept OpenAI-shaped so both the OpenAI and Anthropic API layers can supply them.
 */
export interface GenerationParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ChatCompletionTool[];
  tool_choice?: ChatCompletionToolChoiceOption;
  parallel_tool_calls?: boolean;
}

/**
 * Pick the supported generation params out of an arbitrary request/payload
 * object, omitting undefined keys. Used by the API layer and by the provider
 * side (which reconstructs the call from the mesh payload).
 *
 * `tools` is only picked when it is a **non-empty** array, and the two
 * tool-related knobs only ride along with it: backends without tool support
 * reject a bare `tools: []`, so forwarding an empty array would break plain
 * chat on those backends for no gain.
 */
export function pickGenerationParams(obj: any): GenerationParams {
  const params: GenerationParams = {};
  if (obj?.max_tokens !== undefined) params.max_tokens = obj.max_tokens;
  if (obj?.temperature !== undefined) params.temperature = obj.temperature;
  if (obj?.top_p !== undefined) params.top_p = obj.top_p;
  if (obj?.stop !== undefined) params.stop = obj.stop;
  if (Array.isArray(obj?.tools) && obj.tools.length > 0) {
    params.tools = obj.tools;
    if (obj?.tool_choice !== undefined) params.tool_choice = obj.tool_choice;
    if (obj?.parallel_tool_calls !== undefined) params.parallel_tool_calls = obj.parallel_tool_calls;
  }
  return params;
}

/** Text carried by one message's `content`, whether a string or a part array. */
function messageText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ? String(content) : '';
  return content
    .filter((part: any) => part && (typeof part === 'string' || part.type === 'text'))
    .map((part: any) => (typeof part === 'string' ? part : part.text ?? ''))
    .join('');
}

/**
 * Count input tokens with the llama tokenizer. Pure CPU/JS — no model backend —
 * so the requester can count its own input before requesting a quote, letting
 * the prompt content stay off the broadcast (only the winning provider sees it).
 *
 * Tool schemas and tool-call traffic are counted too: an agent tool like Claude
 * Code sends thousands of tokens of JSON schema on every turn, and leaving them
 * out would under-price provider work and over-estimate what a budget affords.
 * The requester and the provider must count the same way, so both call this
 * with the request's `tools` (see `budgetOutputCap`).
 */
export function countInputTokens(inputs: any[], tools?: any[]): number {
  const count = (text: string) => (text ? tokenizer.encode(text).length : 0);

  let total = (inputs ?? []).reduce((acc: number, input: any) => {
    if (typeof input === 'string') return acc + count(input);

    let tokens = count(messageText(input?.content));

    // Assistant turns that requested a tool call: the name and the JSON
    // arguments are real input tokens when replayed as history.
    for (const call of input?.tool_calls ?? []) {
      tokens += count(call?.function?.name ?? '');
      tokens += count(call?.function?.arguments ?? '');
    }

    return acc + tokens;
  }, 0);

  for (const tool of tools ?? []) {
    const fn = tool?.function ?? tool;
    total += count(fn?.name ?? '');
    total += count(fn?.description ?? '');
    if (fn?.parameters !== undefined) total += count(JSON.stringify(fn.parameters));
  }

  return total;
}

/** When the parts of one streamed completion arrived (`performance.now()` clock). */
export interface StreamTiming {
  tSent: number;
  /** First chunk carrying output (text, reasoning or a tool call); null if none did. */
  tFirst: number | null;
  tLast: number | null;
  outputChunks: number;
}

/** One live inference, reduced to the numbers performance tracking needs. Never any content. */
export interface InferenceSample {
  ttftMs: number;
  /** From first to last output chunk. */
  decodeMs: number;
  promptTokens?: number;
  completionTokens: number;
}

/** Whether the model was already loaded when a request was sent. */
export type Warmth = 'cold' | 'hot' | 'unknown';

/**
 * One System One answer as a performance sample (plan 018). A decision model
 * answers in one piece, so its "first token" is the whole response time and
 * there is no decode rate to measure.
 */
export function systemOneSample(elapsedMs: number, request: SystemOneRequest, body: any): InferenceSample {
  const reported = body?.usage?.input_tokens;
  return {
    ttftMs: elapsedMs,
    decodeMs: 0,
    promptTokens: typeof reported === 'number' ? reported : countSystemOneInputTokens(request.state, request.questions),
    completionTokens: 0,
  };
}

/**
 * Watches live chat and System One inference for performance tracking. `begin` runs just
 * before the request and must be quick; it is never allowed to fail a request.
 */
export interface InferenceObserver {
  begin(model: string): Promise<Warmth>;
  record(model: string, warmth: Warmth, sample: InferenceSample): void;
}

/** A 4xx from the backend: what a runtime that cannot stream (or take `stream_options`) answers. */
function isClientRejection(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

/** Reduce a timed completion to a sample; `null` when it produced no output to time. */
export function toSample(
  timing: StreamTiming,
  completion: OpenAI.Chat.Completions.ChatCompletion,
  messages: ChatCompletionMessageParam[],
  params?: GenerationParams,
): InferenceSample | null {
  if (timing.tFirst === null || timing.tLast === null) return null;
  const message: any = completion.choices?.[0]?.message ?? {};
  const completionTokens = completion.usage?.completion_tokens ?? countInputTokens([
    { content: `${message.content ?? ''}${message.reasoning_content ?? message.reasoning ?? ''}`, tool_calls: message.tool_calls },
  ]);
  return {
    ttftMs: timing.tFirst - timing.tSent,
    decodeMs: timing.tLast - timing.tFirst,
    promptTokens: completion.usage?.prompt_tokens ?? countInputTokens(messages as any[], params?.tools),
    completionTokens,
  };
}

/** What request handling needs from inference: the node's backend or backends (plan 019). */
export type InferenceService = Pick<OpenAIInferenceModel, 'getResponse' | 'systemOne' | 'countEmbeddings'>;

export class OpenAIInferenceModel {
  openai: OpenAI;
  private baseURL: string;
  private readonly apiKey: string;
  nodeEventEmitter: EventEmitter;
  /** Set by the application when performance tracking is on (plan 018). */
  observer?: InferenceObserver;
  /** Models this backend refused to stream; asked plainly from then on. */
  private readonly noStream = new Set<string>();

  /** `apiKey` is this backend's own (plan 019); it defaults to the single-backend `models.apiKey`. */
  constructor(baseURL: string, nodeEvents: EventEmitter, apiKey: string = environment.models?.apiKey ?? '') {
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.openai = new OpenAI({
      baseURL: baseURL,
      // Local backends (Ollama, LM Studio) don't require a key, but the OpenAI
      // SDK rejects a missing/empty one at construction time.
      apiKey: this.apiKey || 'not-needed'
    });
    this.nodeEventEmitter = nodeEvents;
  }

  /**
   * Run a chat completion on the backend and resolve to one whole
   * `ChatCompletion`, exactly as a non-streamed call would.
   *
   * The backend is asked to *stream* only so the node can time it (time to
   * first token, decode rate; plan 018): the chunks are rebuilt here into the
   * completion callers have always received, so billing (backend `usage`) and
   * the API's own output are unchanged. A backend that will not stream is asked
   * again without streaming, and once that works it is not asked to stream that
   * model again.
   */
  async getResponse(model: string, messages: ChatCompletionMessageParam[], params?: GenerationParams): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const warmth = await this.observer?.begin(model).catch(() => 'unknown' as const);
    try {
      const { completion, timing } = await this.chatTimed(model, messages, params);
      if (timing && this.observer) {
        const sample = toSample(timing, completion, messages, params);
        if (sample) this.observer.record(model, warmth ?? 'unknown', sample);
      }
      return completion;
    } catch (error) {
      logger.error("Error getting response from OpenAI model:", error);
      throw error;
    }
  }

  /**
   * One chat completion plus its timings (`null` when the backend had to be
   * asked without streaming). Used by `getResponse` and, directly, by the
   * benchmarker, whose runs are not live traffic and so skip the observer.
   */
  async chatTimed(
    model: string,
    messages: ChatCompletionMessageParam[],
    params?: GenerationParams,
    signal?: AbortSignal,
  ): Promise<{ completion: OpenAI.Chat.Completions.ChatCompletion; timing: StreamTiming | null }> {
    const request = { model, messages, ...(params || {}) };
    if (this.noStream.has(model)) {
      return { completion: await this.openai.chat.completions.create(request, { signal }), timing: null };
    }

    let produced = false;
    try {
      return await this.streamed(request, signal, () => { produced = true; });
    } catch (error) {
      // Only a refusal before anything arrived can mean "I don't stream"; an
      // error mid-stream is a real failure, as it would have been unstreamed.
      if (produced || signal?.aborted || !isClientRejection(error)) throw error;
      const completion = await this.openai.chat.completions.create(request, { signal });
      this.noStream.add(model);
      logger.info(`ℹ️ The model backend would not stream ${model}; using plain requests for it (no live performance figures).`);
      return { completion, timing: null };
    }
  }

  private async streamed(
    request: { model: string; messages: ChatCompletionMessageParam[] } & GenerationParams,
    signal: AbortSignal | undefined,
    onChunk: () => void,
  ): Promise<{ completion: OpenAI.Chat.Completions.ChatCompletion; timing: StreamTiming }> {
    const tSent = performance.now();
    const stream = await this.openai.chat.completions.create(
      { ...request, stream: true, stream_options: { include_usage: true } },
      { signal },
    );

    let id: string | undefined;
    let created: number | undefined;
    let modelName: string | undefined;
    let systemFingerprint: string | undefined;
    let content = '';
    let reasoning = '';
    let reasoningKey: 'reasoning_content' | 'reasoning' | null = null;
    const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
    let finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] | null = null;
    let usage: OpenAI.Completions.CompletionUsage | undefined;
    let tFirst: number | null = null;
    let tLast: number | null = null;
    let outputChunks = 0;

    for await (const chunk of stream) {
      onChunk();
      const now = performance.now();
      id ??= chunk.id;
      created ??= chunk.created;
      modelName ??= chunk.model;
      systemFingerprint ??= chunk.system_fingerprint ?? undefined;
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta: any = choice.delta ?? {};
      let output = false;

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        output = true;
      }
      // Runtimes disagree on the field name; keep whichever this one uses.
      for (const key of ['reasoning_content', 'reasoning'] as const) {
        if (typeof delta[key] === 'string' && delta[key].length > 0) {
          reasoning += delta[key];
          reasoningKey ??= key;
          output = true;
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call?.index === 'number' ? call.index : toolCalls.length;
          const slot = (toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (call.id) slot.id = call.id;
          // The name arrives once; the arguments arrive in pieces.
          if (call.function?.name && !slot.function.name) slot.function.name = call.function.name;
          if (typeof call.function?.arguments === 'string') slot.function.arguments += call.function.arguments;
          output = true;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;

      if (output) {
        tFirst ??= now;
        tLast = now;
        outputChunks++;
      }
    }

    // A dropped connection ends the iteration quietly rather than throwing, and
    // every runtime sends a finish_reason on a completed answer: without one,
    // this is a truncated answer, which must fail rather than be billed whole.
    if (finishReason === null) {
      throw new Error('the model backend stopped streaming before the answer was complete');
    }

    const calls = toolCalls.filter(Boolean);
    const message: any = { role: 'assistant', content, refusal: null };
    if (reasoningKey) message[reasoningKey] = reasoning;
    if (calls.length > 0) message.tool_calls = calls;

    const completion: OpenAI.Chat.Completions.ChatCompletion = {
      id: id ?? `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: created ?? Math.floor(Date.now() / 1000),
      model: modelName ?? request.model,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {}),
      ...(usage ? { usage } : {}),
    };
    return { completion, timing: { tSent, tFirst, tLast, outputChunks } };
  }

  /**
   * Ask a decision model a set of typed questions (`POST {baseURL}/systemone`).
   *
   * The OpenAI SDK has no such method, so this is a plain `fetch` to whatever
   * runtime the node is configured with — nothing here is specific to Ollama.
   * The backend's JSON comes back untouched. A non-2xx answer (a model that is
   * not a decision model, a runtime without the endpoint) throws
   * `BackendRejectedError` carrying the backend's status and message.
   *
   * The whole call is timed for the model's performance figures (plan 018).
   */
  async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<any> {
    const warmth = await this.observer?.begin(request.model).catch(() => 'unknown' as const);
    const { body, elapsedMs } = await this.systemOneTimed(request, signal);
    this.observer?.record(request.model, warmth ?? 'unknown', systemOneSample(elapsedMs, request, body));
    return body;
  }

  /**
   * One System One call plus how long it took, end to end. Used by
   * `systemOne` and, directly, by the benchmarker, which skips the observer.
   */
  async systemOneTimed(request: SystemOneRequest, signal?: AbortSignal): Promise<{ body: any; elapsedMs: number }> {
    const tSent = performance.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/systemone`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ state: request.state, model: request.model, questions: request.questions }),
      });
    } catch (error) {
      logger.error("Error getting System One response from the model backend:", error);
      throw error;
    }

    const text = await response.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const detail = body?.error?.message ?? body?.error ?? (text.trim() || `HTTP ${response.status}`);
      throw new BackendRejectedError(response.status, String(detail));
    }
    if (body === undefined) {
      throw new BackendRejectedError(502, 'The model backend returned a System One response that was not JSON.');
    }
    return { body, elapsedMs: performance.now() - tSent };
  }

  /**
   * List the models the backend is currently serving.
   *
   * The optional `signal` is how `ModelAvailabilityMonitor` bounds its liveness
   * probe. It is deliberately per-call rather than a client-wide `timeout`: the
   * same client runs real inference, which is legitimately slow.
   */
  async getModels(signal?: AbortSignal) {
    const resp = await this.openai.models.list(signal ? { signal } : undefined);
    return resp.data;
  }

  async countEmbeddings(_model: string, inputs: any[], tools?: any[]) {
    return countInputTokens(inputs, tools);
  }
}
