/**
 * System One (`src/utils/systemOne.ts`, `OpenAIInferenceModel.systemOne`).
 *
 * Decision models answer typed questions through `POST /v1/systemone`. The node
 * is a transport and a market for that API, so the contract that matters is
 * that a request survives validation, is priced from its real content, and the
 * backend's answer comes back untouched. The backend here is a stub HTTP
 * server — nothing is specific to Ollama.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { OpenAIInferenceModel } from '../src/utils/models';
import {
  BackendRejectedError,
  countSystemOneInputTokens,
  normalizeUsage,
  validateSystemOneRequest,
} from '../src/utils/systemOne';
import { statusForInferenceError } from '../src/api/inferenceErrors';

const NOUL = { type: 'noul', instructions: 'Does this convey urgency?' };
const valid = (overrides: Record<string, unknown> = {}) => ({
  model: 'tev1:0.8b',
  state: 'Help! My payouts have been failing for 3 days.',
  questions: { is_urgent: NOUL },
  ...overrides,
});

describe('validateSystemOneRequest', () => {
  test('accepts the documented examples', () => {
    expect(validateSystemOneRequest(valid())).toBeNull();
    expect(validateSystemOneRequest(valid({
      questions: {
        department: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: null } },
        frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
        urgent: { type: 'noul', instructions: 'Urgent?', criteria: { true: 'Time-sensitive', false: 'Not urgent' } },
      },
    }))).toBeNull();
    // State can be structured data, not only text.
    expect(validateSystemOneRequest(valid({ state: { ticket: { messages: [{ text: 'hi' }] } } }))).toBeNull();
  });

  test.each([
    ['a non-object body', 'nope', 'JSON object'],
    ['no model', valid({ model: '' }), 'model'],
    ['no state', valid({ state: undefined }), 'state'],
    ['no questions', valid({ questions: {} }), 'at least one'],
    ['an unknown question type', valid({ questions: { q: { type: 'essay', instructions: 'x' } } }), 'unsupported'],
    ['no instructions', valid({ questions: { q: { type: 'noul' } } }), 'instructions'],
    ['a choice without criteria', valid({ questions: { q: { type: 'choice', instructions: 'x' } } }), 'criteria'],
    ['a score with one level', valid({ questions: { q: { type: 'score', instructions: 'x', criteria: ['only'] } } }), 'array of 2'],
    ['a score with eleven levels', valid({ questions: { q: { type: 'score', instructions: 'x', criteria: Array(11).fill('l') } } }), 'array of 2'],
  ])('rejects %s', (_label, body, mention) => {
    expect(validateSystemOneRequest(body)).toContain(mention);
  });

  test('rejects a choice with more than 255 options', () => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    expect(validateSystemOneRequest(valid({ questions: { q: { type: 'choice', instructions: 'x', criteria } } }))).toContain('255');
  });
});

describe('pricing inputs', () => {
  test('input tokens grow with the state and the questions, and are stable', () => {
    const small = countSystemOneInputTokens('hi', { q: NOUL });
    const bigState = countSystemOneInputTokens('hi '.repeat(200), { q: NOUL });
    const moreQuestions = countSystemOneInputTokens('hi', { q: NOUL, r: NOUL, s: NOUL });

    expect(small).toBeGreaterThan(0);
    expect(bigState).toBeGreaterThan(small);
    expect(moreQuestions).toBeGreaterThan(small);
    // The requester and the provider must agree, so it has to be deterministic.
    expect(countSystemOneInputTokens('hi', { q: NOUL })).toBe(small);
  });

  test('structured state is counted, not skipped', () => {
    expect(countSystemOneInputTokens({ a: 'some text here' }, { q: NOUL })).toBeGreaterThan(countSystemOneInputTokens('', { q: NOUL }));
  });

  test('usage is read in either shape', () => {
    expect(normalizeUsage({ input_tokens: 119, output_tokens: 1 })).toEqual({ prompt_tokens: 119, completion_tokens: 1 });
    expect(normalizeUsage({ prompt_tokens: 5, completion_tokens: 7 })).toEqual({ prompt_tokens: 5, completion_tokens: 7 });
    expect(normalizeUsage(undefined)).toEqual({ prompt_tokens: undefined, completion_tokens: undefined });
  });
});

describe('OpenAIInferenceModel.systemOne', () => {
  let server: Server;
  let baseURL: string;
  let seen: { path?: string; method?: string; body?: any; auth?: string } = {};
  let respond: (status: number, payload: string) => void = () => {};
  let nextReply = { status: 200, payload: '{}' };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        seen = { path: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization };
        res.writeHead(nextReply.status, { 'content-type': 'application/json' });
        res.end(nextReply.payload);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    respond = (status, payload) => { nextReply = { status, payload }; };
  });
  afterAll(() => server.close());

  const backend = () => new OpenAIInferenceModel(baseURL, new EventEmitter());

  test('posts the questions to {baseURL}/systemone and returns the answer untouched', async () => {
    const answer = {
      model: 'tev1:0.8b',
      answers: { is_urgent: { type: 'noul', noul: 0.88 } },
      usage: { input_tokens: 119, output_tokens: 1 },
    };
    respond(200, JSON.stringify(answer));

    const result = await backend().systemOne({ model: 'tev1:0.8b', state: 'x', questions: { is_urgent: NOUL } });

    expect(result).toEqual(answer);
    expect(seen.method).toBe('POST');
    expect(seen.path).toBe('/v1/systemone');
    expect(seen.body).toEqual({ state: 'x', model: 'tev1:0.8b', questions: { is_urgent: NOUL } });
  });

  test("a backend's 400 becomes a BackendRejectedError that carries the status and message", async () => {
    respond(400, JSON.stringify({ error: 'model "gemma4:e2b" is not supported by System One; use a local Nimble or Tev GGUF model' }));

    const error = await backend().systemOne({ model: 'gemma4:e2b', state: 'x', questions: { q: NOUL } }).catch((e) => e);

    expect(error).toBeInstanceOf(BackendRejectedError);
    expect(error.status).toBe(400);
    expect(error.message).toContain('not supported by System One');
    // A local 4xx is passed to the caller as-is; the backend being down is a 502.
    expect(statusForInferenceError(error)).toBe(400);
    expect(statusForInferenceError(new BackendRejectedError(500, 'boom'))).toBe(502);
  });

  test('a runtime without the endpoint (404, not JSON) is a rejection, not a crash', async () => {
    respond(404, '404 page not found');

    const error = await backend().systemOne({ model: 'm', state: 'x', questions: { q: NOUL } }).catch((e) => e);

    expect(error).toBeInstanceOf(BackendRejectedError);
    expect(error.status).toBe(404);
  });

  test('a 200 that is not JSON is a bad gateway', async () => {
    respond(200, 'not json');

    const error = await backend().systemOne({ model: 'm', state: 'x', questions: { q: NOUL } }).catch((e) => e);

    expect(error).toBeInstanceOf(BackendRejectedError);
    expect(error.status).toBe(502);
  });
});
