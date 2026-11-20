/**
 * `getResponse` asks the backend to stream only so the node can time it (plan
 * 018). What callers get must not change: the chunks are rebuilt into the same
 * ChatCompletion a plain request returns — text, reasoning, split tool-call
 * arguments, finish_reason and usage (which billing reads). A backend that
 * will not stream is asked plainly, and remembered.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { OpenAIInferenceModel, type InferenceSample, type Warmth } from '../src/utils/models';
import { startStubBackend, words, type StubBackend, type StubBehaviour } from './stubBackend';

let stub: StubBackend | null = null;
afterEach(() => { stub?.stop(); stub = null; });

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

function backendFor(behaviour: StubBehaviour) {
  stub = startStubBackend(behaviour);
  return new OpenAIInferenceModel(`${stub.url}/v1`, new EventEmitter());
}

/** The completion the stub returns for a plain (non-streamed) request. */
async function plainCompletion(behaviour: StubBehaviour) {
  const plain = startStubBackend(behaviour);
  try {
    const res = await fetch(`${plain.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: MESSAGES }),
    });
    return await res.json();
  } finally {
    plain.stop();
  }
}

describe('the rebuilt completion equals the plain one', () => {
  const cases: [string, StubBehaviour][] = [
    ['plain text', { chunks: words(5) }],
    ['reasoning then text', { chunks: [{ reasoning: 'think ' }, { reasoning: 'more' }, { content: 'answer' }] }],
    ['two tool calls with split arguments', {
      finishReason: 'tool_calls',
      chunks: [
        { toolCalls: [{ index: 0, id: 'call_a', name: 'read_file', arguments: '{"pa' }] },
        { toolCalls: [{ index: 0, arguments: 'th":"a.ts"}' }] },
        { toolCalls: [{ index: 1, id: 'call_b', name: 'grep', arguments: '' }] },
        { toolCalls: [{ index: 1, arguments: '{"q":"x"}' }] },
      ],
    }],
    ['a length cut-off', { chunks: words(3), finishReason: 'length' }],
  ];

  for (const [label, behaviour] of cases) {
    test(label, async () => {
      const expected = await plainCompletion(behaviour);
      const got: any = await backendFor(behaviour).getResponse('stub-model', MESSAGES);
      expect(stub!.requests[0].stream).toBe(true);
      expect(got.choices[0].message.content).toBe(expected.choices[0].message.content);
      expect(got.choices[0].message.reasoning_content).toBe(expected.choices[0].message.reasoning_content);
      expect(got.choices[0].message.tool_calls).toEqual(expected.choices[0].message.tool_calls);
      expect(got.choices[0].finish_reason).toBe(expected.choices[0].finish_reason);
      expect(got.usage).toEqual(expected.usage);
      expect(got.id).toBe(expected.id);
      expect(got.model).toBe(expected.model);
    });
  }

  test('no usage from the backend means no usage on the completion (billing then counts locally)', async () => {
    const got = await backendFor({ chunks: words(3), usage: null }).getResponse('stub-model', MESSAGES);
    expect(got.usage).toBeUndefined();
  });
});

describe('a backend that will not stream', () => {
  test('is asked again without streaming, and not asked to stream that model again', async () => {
    const backend = backendFor({ chunks: words(3), rejectStreamStatus: 400 });
    const first = await backend.getResponse('stub-model', MESSAGES);
    expect(first.choices[0].message.content).toBe('w0 w1 w2 ');
    await backend.getResponse('stub-model', MESSAGES);
    expect(stub!.requests.map((r) => r.stream)).toEqual([true, false, false]);
  });

  test('a mid-stream failure is a failure, not a reason to retry', async () => {
    const backend = backendFor({ chunks: words(5), dieAfterChunks: 2 });
    await expect(backend.getResponse('stub-model', MESSAGES)).rejects.toThrow();
    expect(stub!.requests.length).toBe(1);
  });
});

describe('the observer', () => {
  test('gets one sample per inference with plausible timings, and never any content', async () => {
    const backend = backendFor({ chunks: words(10), firstTokenDelayMs: 120, interChunkDelayMs: 20 });
    const seen: { model: string; warmth: Warmth; sample: InferenceSample }[] = [];
    backend.observer = {
      begin: async () => 'hot',
      record: (model, warmth, sample) => seen.push({ model, warmth, sample }),
    };
    await backend.getResponse('stub-model', MESSAGES);
    expect(seen.length).toBe(1);
    const { warmth, sample } = seen[0];
    expect(warmth).toBe('hot');
    expect(sample.ttftMs).toBeGreaterThanOrEqual(100);
    expect(sample.decodeMs).toBeGreaterThanOrEqual(150);
    expect(sample.completionTokens).toBe(40); // from the backend's usage
    expect(sample.promptTokens).toBe(12);
    expect(Object.keys(sample).sort()).toEqual(['completionTokens', 'decodeMs', 'promptTokens', 'ttftMs']);
  });

  test('an observer that fails cannot fail the request', async () => {
    const backend = backendFor({ chunks: words(3) });
    backend.observer = { begin: async () => { throw new Error('boom'); }, record: () => {} };
    const got = await backend.getResponse('stub-model', MESSAGES);
    expect(got.choices[0].message.content).toBe('w0 w1 w2 ');
  });

  test('no sample when the backend had to be asked plainly', async () => {
    const backend = backendFor({ chunks: words(3), rejectStreamStatus: 400 });
    let samples = 0;
    backend.observer = { begin: async () => 'hot', record: () => { samples++; } };
    await backend.getResponse('stub-model', MESSAGES);
    expect(samples).toBe(0);
  });
});
