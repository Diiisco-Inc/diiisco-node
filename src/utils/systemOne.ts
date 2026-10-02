import tokenizer from 'llama-tokenizer-js';

/**
 * System One — the typed-question API that decision models (Tev, Nimble, Jev)
 * speak. DIIISCO is a transport and a market for it: the request and the
 * response cross the mesh unchanged, and it is the model backend that answers.
 *
 *   POST /v1/systemone
 *   { state, model, questions: { <id>: { type: "noul"|"choice"|"score", instructions, criteria? } } }
 *   → { model, answers: { <id>: { type, noul | choice | score, ... } }, usage: { input_tokens, output_tokens } }
 *
 * Reference: https://docs.typesafe.ai/api.md
 */

export const SYSTEMONE_QUESTION_TYPES = ['noul', 'choice', 'score'] as const;
export type SystemOneQuestionType = (typeof SYSTEMONE_QUESTION_TYPES)[number];

/** TypeSafe's published limits. */
export const SYSTEMONE_MAX_CHOICE_OPTIONS = 255;
export const SYSTEMONE_MIN_SCORE_LEVELS = 2;
export const SYSTEMONE_MAX_SCORE_LEVELS = 10;

/** What crosses the mesh and reaches the backend. */
export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, any>;
}

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Structural check, so garbage never starts an auction or reaches a backend.
 * Returns a message fit to show the caller, or `null` when the request is
 * well-formed. It is deliberately not a full schema: the backend stays the
 * authority on what a good question is.
 */
export function validateSystemOneRequest(body: unknown): string | null {
  if (!isPlainObject(body)) return 'The request body must be a JSON object.';
  if (typeof body.model !== 'string' || body.model.trim() === '') return 'Missing `model`.';
  if (body.state === undefined || body.state === null) return 'Missing `state`.';
  if (!isPlainObject(body.questions) || Object.keys(body.questions).length === 0) {
    return '`questions` must be an object with at least one question.';
  }

  for (const [id, question] of Object.entries(body.questions)) {
    if (!isPlainObject(question)) return `Question "${id}" must be an object.`;
    if (!SYSTEMONE_QUESTION_TYPES.includes(question.type)) {
      return `Question "${id}" has an unsupported \`type\` (use ${SYSTEMONE_QUESTION_TYPES.join(', ')}).`;
    }
    if (question.instructions === undefined || question.instructions === null || question.instructions === '') {
      return `Question "${id}" is missing \`instructions\`.`;
    }

    if (question.type === 'choice') {
      if (!isPlainObject(question.criteria) || Object.keys(question.criteria).length === 0) {
        return `Choice question "${id}" needs \`criteria\`: an object of option → description.`;
      }
      if (Object.keys(question.criteria).length > SYSTEMONE_MAX_CHOICE_OPTIONS) {
        return `Choice question "${id}" has more than ${SYSTEMONE_MAX_CHOICE_OPTIONS} options.`;
      }
    } else if (question.type === 'score') {
      const levels = question.criteria;
      if (!Array.isArray(levels) || levels.length < SYSTEMONE_MIN_SCORE_LEVELS || levels.length > SYSTEMONE_MAX_SCORE_LEVELS) {
        return `Score question "${id}" needs \`criteria\`: an array of ${SYSTEMONE_MIN_SCORE_LEVELS}–${SYSTEMONE_MAX_SCORE_LEVELS} level descriptions.`;
      }
    } else if (question.criteria !== undefined && !isPlainObject(question.criteria)) {
      return `Noul question "${id}" has \`criteria\` that is not an object.`;
    }
  }
  return null;
}

const countText = (text: string): number => (text ? tokenizer.encode(text).length : 0);
const asText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));

/**
 * Input tokens for a System One request: the state and the questions. The
 * requester counts this before quoting and the provider re-counts it from the
 * real content, exactly as for chat (`countInputTokens`), so the two sides
 * agree on what the budget affords.
 */
export function countSystemOneInputTokens(state: unknown, questions: unknown): number {
  return countText(asText(state)) + countText(asText(questions));
}

/**
 * Token usage in the shape pricing reads. System One reports
 * `{ input_tokens, output_tokens }`; chat completions report
 * `{ prompt_tokens, completion_tokens }`.
 */
export function normalizeUsage(usage: any): { prompt_tokens?: number; completion_tokens?: number } {
  return {
    prompt_tokens: usage?.prompt_tokens ?? usage?.input_tokens,
    completion_tokens: usage?.completion_tokens ?? usage?.output_tokens,
  };
}

/**
 * The backend answered, but with an error — most usefully a 400 for a model
 * that is not a decision model. Carries the status so a locally served request
 * can hand it straight back to the caller.
 */
export class BackendRejectedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BackendRejectedError';
    this.status = status;
  }
}
