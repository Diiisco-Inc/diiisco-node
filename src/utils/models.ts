import OpenAI from "openai";
import environment from "../environment/environment";
import tokenizer from "llama-tokenizer-js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
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
}

/**
 * Pick the supported generation params out of an arbitrary request/payload
 * object, omitting undefined keys. Used by the API layer and by the provider
 * side (which reconstructs the call from the mesh payload).
 */
export function pickGenerationParams(obj: any): GenerationParams {
  const params: GenerationParams = {};
  if (obj?.max_tokens !== undefined) params.max_tokens = obj.max_tokens;
  if (obj?.temperature !== undefined) params.temperature = obj.temperature;
  if (obj?.top_p !== undefined) params.top_p = obj.top_p;
  if (obj?.stop !== undefined) params.stop = obj.stop;
  return params;
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
      apiKey: this.env.models.apiKey
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

  async getModels() {
    const resp = await this.openai.models.list();
    return resp.data;
  }

  async countEmbeddings(model: string, inputs: any[]) {
    return inputs.reduce((acc, input) => {
      let text: string;
      if (typeof input === 'string') {
        text = input;
      } else if (Array.isArray(input.content)) {
        text = input.content
          .filter((part: any) => part.type === 'text')
          .map((part: any) => part.text)
          .join('');
      } else {
        text = input.content || '';
      }
      const tokens = tokenizer.encode(text);
      return acc + tokens.length;
    }, 0);
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