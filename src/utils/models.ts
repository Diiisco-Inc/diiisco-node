import OpenAI from "openai";
import environment from "../environment/environment";
import tokenizer from "llama-tokenizer-js";

export class OpenAIInferenceModel {
  openai: OpenAI;
  constructor(baseURL: string) {
    this.openai = new OpenAI({
      baseURL: baseURL,
      apiKey: environment.models.apiKey
    });
  }

  async getResponse(model: string, messages:any) {
    const resp = await this.openai.chat.completions.create({
      model: model,
      messages: messages
    });
    return resp;
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