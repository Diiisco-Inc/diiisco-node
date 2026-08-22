import OpenAI from "openai";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import { Response } from "express";
import { GenerationParams } from "../utils/models";

/**
 * Adapter between the Anthropic Messages API wire format and the node's
 * internal OpenAI-shaped inference flow.
 *
 * Scope: text content blocks, tool use (definitions, calls and results) and
 * core generation params. Images and extended thinking are still not
 * translated — those content blocks are ignored rather than rejected, and
 * unknown params pass through untouched.
 *
 * The internal wire stays OpenAI-shaped end to end: this module is a pure
 * translation at the edge, and everything downstream of it (the mesh payload,
 * the provider, the backend call) speaks OpenAI tools.
 */

// ---------------------------------------------------------------------------
// Types (minimal subset of the Anthropic Messages API)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlockParam {
  type: "text";
  text: string;
}

/** An assistant turn's request to call a tool, replayed back to us as history. */
export interface AnthropicToolUseBlockParam {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

/** The client's report of what a tool returned. Always sits in a user turn. */
export interface AnthropicToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlockParam[];
  is_error?: boolean;
}

/** A content block in a request; anything else is ignored (images, thinking). */
export type AnthropicContentBlockParam =
  | AnthropicTextBlockParam
  | AnthropicToolUseBlockParam
  | AnthropicToolResultBlockParam
  | { type: string; [key: string]: any };

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlockParam[];
}

/** A tool definition. `input_schema` is the JSON Schema for the arguments. */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, any>;
  [key: string]: any;
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "none" }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string | AnthropicTextBlockParam[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, any>;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
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
function contentToText(content: string | AnthropicContentBlockParam[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof (block as AnthropicTextBlockParam).text === "string")
    .map((block) => (block as AnthropicTextBlockParam).text)
    .join("");
}

/** Normalise a message's `content` to a block array. */
function toBlocks(content: string | AnthropicContentBlockParam[]): AnthropicContentBlockParam[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content.filter(Boolean) : [];
}

/**
 * A tool-call id for a backend that didn't supply one (llama.cpp and older
 * Ollama builds return `tool_calls` without `id`). Synthesized on the response
 * side, it goes out in the message *we* hand the client, so the id the client
 * echoes back in the next turn's `tool_result` still matches.
 */
function synthesizeToolId(): string {
  return "toolu_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/**
 * Parse a model-generated `arguments` string. Models do not always emit valid
 * JSON, and Anthropic requires `input` to be an object — degrade to `{}`
 * rather than throwing, so one malformed tool payload can't 500 the turn.
 */
function safeParseArguments(args: string | undefined): Record<string, any> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Anthropic tool definitions -> OpenAI function tools (`input_schema` -> `parameters`). */
export function translateTools(tools: AnthropicTool[] | undefined): ChatCompletionFunctionTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const translated = tools
    .filter((tool) => tool && typeof tool.name === "string" && tool.name)
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));

  return translated.length > 0 ? translated : undefined;
}

/** Anthropic `tool_choice` -> OpenAI `tool_choice`. */
export function translateToolChoice(
  choice: AnthropicToolChoice | undefined,
): ChatCompletionToolChoiceOption | undefined {
  if (!choice || typeof choice !== "object") return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
    default:
      return undefined;
  }
}

/** The text an OpenAI `tool` message carries for one Anthropic tool result. */
function toolResultText(block: AnthropicToolResultBlockParam): string {
  const text = contentToText(block.content);
  // OpenAI tool messages have no error flag, so the only way to tell the model
  // the call failed is in the content itself.
  return block.is_error ? `Error: ${text}` : text;
}

/**
 * Translate one Anthropic message into zero or more OpenAI messages.
 *
 * The fan-out is what makes tool history survive: an assistant turn carries
 * its `tool_use` blocks as `tool_calls`, and a user turn's `tool_result`
 * blocks each become their own `role: "tool"` message, emitted *before* any
 * remaining user text — OpenAI requires every tool message to follow directly
 * from the assistant turn that requested it. A message that would end up with
 * neither content nor tool calls is dropped rather than sent empty; backends
 * reject empty-content messages, and the old text-only flattening produced one
 * for every tool turn.
 */
function translateMessage(message: AnthropicMessageParam): ChatCompletionMessageParam[] {
  const blocks = toBlocks(message.content);
  const text = contentToText(blocks);

  if (message.role === "assistant") {
    const toolCalls: ChatCompletionMessageToolCall[] = blocks
      .filter((block): block is AnthropicToolUseBlockParam => block.type === "tool_use")
      .map((block) => ({
        id: block.id || synthesizeToolId(),
        type: "function" as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));

    if (!text && toolCalls.length === 0) return [];

    const assistant: ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: text || null,
    };
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    return [assistant];
  }

  const messages: ChatCompletionMessageParam[] = [];

  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    const result = block as AnthropicToolResultBlockParam;
    if (!result.tool_use_id) continue;
    messages.push({
      role: "tool",
      tool_call_id: result.tool_use_id,
      content: toolResultText(result),
    });
  }

  if (text) messages.push({ role: "user", content: text });

  return messages;
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
 * generation params — tool definitions included.
 */
export function anthropicToOpenAIInputs(body: AnthropicMessagesRequest): OpenAIShapedRequest {
  const inputs: ChatCompletionMessageParam[] = [];

  if (body.system !== undefined) {
    const systemText = typeof body.system === "string" ? body.system : contentToText(body.system);
    if (systemText) inputs.push({ role: "system", content: systemText });
  }

  for (const message of body.messages ?? []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    inputs.push(...translateMessage(message));
  }

  const params: GenerationParams = {};
  if (body.max_tokens !== undefined) params.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.stop_sequences !== undefined) params.stop = body.stop_sequences;

  const tools = translateTools(body.tools);
  if (tools) {
    params.tools = tools;
    const toolChoice = translateToolChoice(body.tool_choice);
    if (toolChoice !== undefined) params.tool_choice = toolChoice;
    if (body.tool_choice && (body.tool_choice as any).disable_parallel_tool_use === true) {
      params.parallel_tool_calls = false;
    }
  }

  return { model: body.model, inputs, params };
}

// ---------------------------------------------------------------------------
// Response translation: internal OpenAI completion -> Anthropic Message
// ---------------------------------------------------------------------------

/**
 * Map an OpenAI finish_reason to an Anthropic stop_reason.
 *
 * Deliberately never returns `"tool_use"`: that stop reason is a promise that
 * the message contains at least one `tool_use` block, so only
 * `openAIToAnthropicMessage` — which knows what blocks it actually built — is
 * allowed to set it. A backend that reports `finish_reason: "tool_calls"` but
 * emits nothing parseable ends the turn instead of sending Claude Code hunting
 * for a tool call that isn't there.
 */
export function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
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

/** OpenAI `tool_calls` on a completion choice -> Anthropic `tool_use` blocks. */
function toolUseBlocks(choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined): AnthropicToolUseBlock[] {
  const calls = (choice?.message as any)?.tool_calls;
  if (!Array.isArray(calls)) return [];

  return calls
    .filter((call: any) => call && call.function && typeof call.function.name === "string")
    .map((call: any) => ({
      type: "tool_use" as const,
      id: typeof call.id === "string" && call.id ? call.id : synthesizeToolId(),
      name: call.function.name,
      input: safeParseArguments(call.function.arguments),
    }));
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
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const toolBlocks = toolUseBlocks(choice);

  const content: AnthropicContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  content.push(...toolBlocks);
  // Preserve the historical shape for an empty pure-text reply.
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: typeof completion?.id === "string" && completion.id ? "msg_" + completion.id : randomId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolBlocks.length > 0 ? "tool_use" : mapStopReason(choice?.finish_reason),
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
  content_block:
    | { type: "text"; text: "" }
    | { type: "tool_use"; id: string; name: string; input: Record<string, never> };
}
export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
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
 * Emits an already-computed completion as a batched SSE stream — one delta per
 * content block, not incremental generation.
 * `OpenAIInferenceModel.getResponse` is non-streaming, so by the time this
 * runs the full response already exists; this only changes how it's framed
 * on the wire so Claude Code's stream parser accepts it (it always sends
 * `stream: true` and has no way to be told not to).
 *
 * Tool calls are framed the way Claude Code accumulates them: a
 * `content_block_start` of type `tool_use` carrying the id and name, then the
 * arguments as a single `input_json_delta`. Sending a tool call as text — as
 * this did before tool support — is exactly what left Claude Code unable to
 * parse a tool call out of the stream.
 */
export function streamAnthropicMessage(
  res: Response,
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): void {
  const message = openAIToAnthropicMessage(completion, model);

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

  message.content.forEach((block, index) => {
    const blockStart: ContentBlockStartEvent = {
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use"
          ? { type: "tool_use", id: block.id, name: block.name, input: {} }
          : { type: "text", text: "" },
    };
    writeSSE(res, "content_block_start", blockStart);

    const delta: ContentBlockDeltaEvent | null =
      block.type === "tool_use"
        ? {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
          }
        : block.text
          ? { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }
          : null;
    if (delta) writeSSE(res, "content_block_delta", delta);

    const blockStop: ContentBlockStopEvent = { type: "content_block_stop", index };
    writeSSE(res, "content_block_stop", blockStop);
  });

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
