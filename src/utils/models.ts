import OpenAI from "openai";

export class OpenAIInferenceModel {
  openai: OpenAI;
  constructor(baseURL: string) {
    this.openai = new OpenAI({
      baseURL: baseURL,
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
    return resp;
  }
}