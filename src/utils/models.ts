import OpenAI from "openai";
import environment from "../environment/environment";
import tokenizer from "llama-tokenizer-js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { logger } from './logger';
import { Environment } from "../environment/environment.types";

export class OpenAIInferenceModel {
  openai: OpenAI;
  private env: Environment;

  constructor(baseURL: string) {
    this.env = environment;
    this.openai = new OpenAI({
      baseURL: baseURL,
      apiKey: this.env.models.apiKey
    });
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

  async countEmbeddings(model: string, inputs: string[]) {
    return inputs.reduce((acc, input) => {
      const tokens = tokenizer.encode(input);
      return acc + tokens.length;
    }, 0);
  }
}