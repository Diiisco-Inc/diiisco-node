import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { Response } from "express";
import { GenerationParams } from "../utils/models";

/**
 * Adapter between the Anthropic Messages API wire format and the node's
 * internal OpenAI-shaped inference flow.
 *
 * Scope (first pass): text content blocks + core generation params. Tools,
 * images, and extended thinking are intentionally not translated — non-text
 * content blocks are ignored rather than rejected, and unknown params pass
 * through untouched.
 */

// ---------------------------------------------------------------------------
// Types (minimal subset of the Anthropic Messages API)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlockParam {
  type: "text";
  text: string;
}

/** A content block in a request; we only translate `type: "text"`. */
export type AnthropicContentBlockParam = AnthropicTextBlockParam | { type: string; [key: string]: any };

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlockParam[];
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string | AnthropicTextBlockParam[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: Record<string, any>;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicTextBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** Anthropic-format error envelope. */
export interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

export const anthropicError = (type: string, message: string): AnthropicError => ({
  type: "error",
  error: { type, message },
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * Validate an incoming Messages request. Returns an Anthropic-format error
 * object if invalid, or `null` if the request is acceptable.
 */
export function validateMessagesRequest(body: any): AnthropicError | null {
  if (!body || typeof body !== "object") {
    return anthropicError("invalid_request_error", "Request body must be a JSON object.");
  }
  if (typeof body.model !== "string" || !body.model) {
    return anthropicError("invalid_request_error", "\"model\" is required.");
  }
  if (typeof body.max_tokens !== "number" || body.max_tokens <= 0) {
    return anthropicError("invalid_request_error", "\"max_tokens\" is required and must be a positive integer.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return anthropicError("invalid_request_error", "\"messages\" is required and must be a non-empty array.");
  }
  return null;
}

/** Validate the reduced request accepted by count_tokens (no max_tokens). */
export function validateCountTokensRequest(body: any): AnthropicError | null {
  if (!body || typeof body !== "object") {
    return anthropicError("invalid_request_error", "Request body must be a JSON object.");
  }
  if (typeof body.model !== "string" || !body.model) {
    return anthropicError("invalid_request_error", "\"model\" is required.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return anthropicError("invalid_request_error", "\"messages\" is required and must be a non-empty array.");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request translation: Anthropic -> internal OpenAI shape
// ---------------------------------------------------------------------------

/** Flatten Anthropic content (string or block array) to plain text. */
function contentToText(content: string | AnthropicContentBlockParam[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof (block as AnthropicTextBlockParam).text === "string")
    .map((block) => (block as AnthropicTextBlockParam).text)
    .join("");
}

export interface OpenAIShapedRequest {
  model: string;
  inputs: ChatCompletionMessageParam[];
  params: GenerationParams;
}

/**
 * Translate an Anthropic Messages request into the node's internal OpenAI
 * shape: a `model`, an `inputs` message array (with the top-level `system`
 * prompt folded in as a leading system message), and forwardable
 * generation params.
 */
export function anthropicToOpenAIInputs(body: AnthropicMessagesRequest): OpenAIShapedRequest {
  const inputs: ChatCompletionMessageParam[] = [];

  if (body.system !== undefined) {
    const systemText = typeof body.system === "string" ? body.system : contentToText(body.system);
    if (systemText) inputs.push({ role: "system", content: systemText });
  }

  for (const message of body.messages) {
    inputs.push({
      role: message.role,
      content: contentToText(message.content),
    } as ChatCompletionMessageParam);
  }

  const params: GenerationParams = {};
  if (body.max_tokens !== undefined) params.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.stop_sequences !== undefined) params.stop = body.stop_sequences;

  return { model: body.model, inputs, params };
}

// ---------------------------------------------------------------------------
// Response translation: internal OpenAI completion -> Anthropic Message
// ---------------------------------------------------------------------------

/** Map an OpenAI finish_reason to an Anthropic stop_reason. */
export function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case "stop":
    default:
      return "end_turn";
  }
}

function randomId(): string {
  // Short, non-cryptographic id — mirrors Anthropic's "msg_..." shape.
  return "msg_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/**
 * Translate an OpenAI ChatCompletion into an Anthropic Message. `model` is
 * passed explicitly so the response echoes the requested model name.
 */
export function openAIToAnthropicMessage(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): AnthropicMessage {
  const choice = completion?.choices?.[0];
  const text = (choice?.message?.content as string) ?? "";

  return {
    id: typeof completion?.id === "string" && completion.id ? "msg_" + completion.id : randomId(),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion?.usage?.prompt_tokens ?? 0,
      output_tokens: completion?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming: an already-computed AnthropicMessage, framed as SSE
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the Anthropic Messages streaming event types — just
 * enough to frame one already-complete response as a valid stream. Shapes
 * verified against a working Claude Code integration (ollama's
 * `anthropic.MessageStartEvent` etc., `ollama/anthropic/anthropic.go`).
 */
export interface MessageStartEvent {
  type: "message_start";
  message: AnthropicMessage;
}
export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: { type: "text"; text: "" };
}
export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string };
}
export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}
export interface MessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason: string | null; stop_sequence: string | null };
  usage: { output_tokens: number };
}
export interface MessageStopEvent {
  type: "message_stop";
}

function writeSSE(res: Response, eventType: string, data: unknown): void {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Emits an already-computed completion as a batched SSE stream — one
 * `text_delta` carrying the whole message, not incremental generation.
 * `OpenAIInferenceModel.getResponse` is non-streaming, so by the time this
 * runs the full response already exists; this only changes how it's framed
 * on the wire so Claude Code's stream parser accepts it (it always sends
 * `stream: true` and has no way to be told not to).
 */
export function streamAnthropicMessage(
  res: Response,
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): void {
  const message = openAIToAnthropicMessage(completion, model);
  const text = message.content[0]?.text ?? "";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const messageStart: MessageStartEvent = {
    type: "message_start",
    message: { ...message, content: [], usage: { ...message.usage, output_tokens: 0 } },
  };
  writeSSE(res, "message_start", messageStart);

  const blockStart: ContentBlockStartEvent = {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  };
  writeSSE(res, "content_block_start", blockStart);

  const blockDelta: ContentBlockDeltaEvent = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  };
  writeSSE(res, "content_block_delta", blockDelta);

  const blockStop: ContentBlockStopEvent = { type: "content_block_stop", index: 0 };
  writeSSE(res, "content_block_stop", blockStop);

  const messageDelta: MessageDeltaEvent = {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: { output_tokens: message.usage.output_tokens },
  };
  writeSSE(res, "message_delta", messageDelta);

  const messageStop: MessageStopEvent = { type: "message_stop" };
  writeSSE(res, "message_stop", messageStop);

  res.end();
}
