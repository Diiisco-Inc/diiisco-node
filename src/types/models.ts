import type { Model } from 'openai/resources/index';

/**
 * What a served model is *for*. The standard `/v1/models` listing has no such
 * field, so a chat tool's model picker used to offer embedding and decision
 * models that cannot hold a conversation.
 *
 * - `chat`      — the default: generates text from a conversation.
 * - `embedding` — turns text into a vector; no chat completion.
 * - `decision`  — a System One model that answers typed questions
 *                 (`/v1/systemone`); a chat call on one returns no content.
 */
export type ModelKind = 'chat' | 'embedding' | 'decision';

export const MODEL_KINDS: readonly ModelKind[] = ['chat', 'embedding', 'decision'];

/**
 * A model as this node lists it: the OpenAI `Model` plus what the node worked
 * out about it. Both extra fields are optional so listings from older nodes —
 * which carry neither — are still valid, and are read as `chat`.
 */
export interface ModelInfo extends Model {
  kind?: ModelKind;
  /** The raw capability strings the backend reported, when it reported any. */
  capabilities?: string[];
}
