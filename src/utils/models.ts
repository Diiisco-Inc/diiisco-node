import OpenAI from "openai";
import environment from "../environment/runtime";
import tokenizer from "llama-tokenizer-js";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import { logger } from './logger';
import { Environment } from "../environment/environment.types";
import { Model } from "openai/resources/index";
import EventEmitter from "events";

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

export class OpenAIInferenceModel {
  openai: OpenAI;
  private env: Environment;
  nodeEventEmitter: EventEmitter;
  availableModels: Model[] = [];

  constructor(baseURL: string, nodeEvents: EventEmitter) {
    this.env = environment;
    this.openai = new OpenAI({
      baseURL: baseURL,
      // Local backends (Ollama, LM Studio) don't require a key, but the OpenAI
      // SDK rejects a missing/empty one at construction time.
      apiKey: this.env.models.apiKey || 'not-needed'
    });
    this.nodeEventEmitter = nodeEvents;
  }

  async getResponse(model: string, messages: ChatCompletionMessageParam[], params?: GenerationParams): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      const resp = await this.openai.chat.completions.create({
        model: model,
        messages: messages,
        ...(params || {}),
      });
      return resp;
    } catch (error) {
      logger.error("Error getting response from OpenAI model:", error);
      throw error;
    }
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

  async countEmbeddings(model: string, inputs: any[], tools?: any[]) {
    return countInputTokens(inputs, tools);
  }

  async addModel(models: Model[]) {

    if (this.availableModels.length === 0) {
      this.availableModels = models;
      setTimeout(() => {
        const uniqueModels = this.availableModels.filter((model, index, self) => 
          index === self.findIndex((m) => m.id === model.id)
        );
        this.nodeEventEmitter.emit(`model-list-compiled`, uniqueModels);
        logger.info(`✅ Model list compiled and event emitted: ${JSON.stringify(uniqueModels)}`);
        this.availableModels = [];
      }, environment.quoteEngine.waitTime || 5000);
    } else {
      this.availableModels = [...this.availableModels, ...models];
    }
    
  }
}