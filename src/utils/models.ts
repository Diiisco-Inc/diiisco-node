import OpenAI from "openai";
import environment from "../environment/environment";
import tokenizer from "llama-tokenizer-js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { logger } from './logger';
import { Environment } from "../environment/environment.types";
import { Model } from "openai/resources/index";
import EventEmitter from "events";

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

  async getResponse(model: string, messages: ChatCompletionMessageParam[]): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      const resp = await this.openai.chat.completions.create({
        model: model,
        messages: messages
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
      const text = typeof input === 'string' ? input : (input.content || '');
      const tokens = tokenizer.encode(String(text));
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