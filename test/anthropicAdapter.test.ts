/**
 * Anthropic <-> OpenAI translation (`src/api/anthropicAdapter.ts`).
 *
 * Unlike the rest of this suite, these run against the **source** rather than
 * the compiled binary: the translation is pure functions with no process, no
 * config and no network, and the failure mode they guard against — a tool call
 * that silently degrades into text, which is what stopped `diiisco launch
 * claude` from executing a single tool — is invisible to a CLI smoke test.
 */
import { describe, expect, test } from 'bun:test';
import {
  anthropicToOpenAIInputs,
  openAIToAnthropicMessage,
  streamAnthropicMessage,
  translateToolChoice,
  AnthropicMessagesRequest,
} from '../src/api/anthropicAdapter';
import { countInputTokens, pickGenerationParams } from '../src/utils/models';

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Look up the weather.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

/** A completion in the shape a tool-capable backend (Ollama, vLLM) returns. */
const toolCallCompletion = (args: string, id = 'call_abc') =>
  ({
    id: 'cmpl-1',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'get_weather', arguments: args } }] },
        logprobs: null,
      },
    ],
    created: 0,
    model: 'test',
    object: 'chat.completion',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }) as any;

const textCompletion = (text: string) =>
  ({
    id: 'cmpl-2',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text }, logprobs: null }],
    created: 0,
    model: 'test',
    object: 'chat.completion',
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }) as any;

/** Collect the SSE frames `streamAnthropicMessage` writes. */
function captureStream(completion: any, model = 'test'): Array<{ event: string; data: any }> {
  const chunks: string[] = [];
  const res: any = {
    writeHead: () => res,
    write: (chunk: string) => chunks.push(chunk),
    end: () => undefined,
  };
  streamAnthropicMessage(res, completion, model);

  return chunks
    .join('')
    .split('\n\n')
    .filter((frame) => frame.trim() !== '')
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return { event: eventLine.replace(/^event: /, ''), data: JSON.parse(dataLine.replace(/^data: /, '')) };
    });
}

describe('anthropicToOpenAIInputs — tool definitions', () => {
  test('translates tools, renaming input_schema to parameters', () => {
    const { params } = anthropicToOpenAIInputs({
      model: 'm',
      max_tokens: 100,
      tools: [WEATHER_TOOL],
      messages: [{ role: 'user', content: 'weather in Bath?' }],
    } as AnthropicMessagesRequest);

    expect(params.tools).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'Look up the weather.', parameters: WEATHER_TOOL.input_schema },
      },
    ]);
  });

  test('omits tools entirely when the request has none', () => {
    const { params } = anthropicToOpenAIInputs({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    } as AnthropicMessagesRequest);

    expect(params.tools).toBeUndefined();
    expect('tools' in params).toBe(false);
  });

  test('maps every tool_choice variant', () => {
    expect(translateToolChoice({ type: 'auto' })).toBe('auto');
    expect(translateToolChoice({ type: 'any' })).toBe('required');
    expect(translateToolChoice({ type: 'none' })).toBe('none');
    expect(translateToolChoice({ type: 'tool', name: 'get_weather' })).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  test('disable_parallel_tool_use becomes parallel_tool_calls: false', () => {
    const { params } = anthropicToOpenAIInputs({
      model: 'm',
      max_tokens: 100,
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: 'hi' }],
    } as AnthropicMessagesRequest);

    expect(params.parallel_tool_calls).toBe(false);
  });
});

describe('anthropicToOpenAIInputs — tool history', () => {
  const withHistory = () =>
    anthropicToOpenAIInputs({
      model: 'm',
      max_tokens: 100,
      tools: [WEATHER_TOOL],
      messages: [
        { role: 'user', content: 'weather in Bath?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Bath' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '17C and raining' }],
        },
      ],
    } as AnthropicMessagesRequest);

  test('assistant tool_use becomes tool_calls alongside its text', () => {
    const assistant: any = withHistory().inputs[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('Let me check.');
    expect(assistant.tool_calls).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bath"}' } },
    ]);
  });

  test('tool_result becomes a role:"tool" message carrying the id', () => {
    const toolMessage: any = withHistory().inputs[2];
    expect(toolMessage).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: '17C and raining' });
  });

  test('tool results are emitted before any trailing user text', () => {
    const { inputs } = anthropicToOpenAIInputs({
      model: 'm',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' },
            { type: 'text', text: 'now summarise it' },
          ],
        },
      ],
    } as AnthropicMessagesRequest);

    expect(inputs.map((m: any) => m.role)).toEqual(['tool', 'user']);
  });

  test('is_error surfaces in the tool content', () => {
    const { inputs } = anthropicToOpenAIInputs({
      model: 'm',
      max_tokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'no such file', is_error: true }] },
      ],
    } as AnthropicMessagesRequest);

    expect((inputs[0] as any).content).toBe('Error: no such file');
  });

  test('drops a message that carries nothing translatable instead of sending it empty', () => {
    const { inputs } = anthropicToOpenAIInputs({
      model: 'm',
      max_tokens: 100,
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' } as any] },
        { role: 'user', content: 'hi' },
      ],
    } as AnthropicMessagesRequest);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('openAIToAnthropicMessage', () => {
  test('a backend tool call becomes a tool_use block with parsed input', () => {
    const message = openAIToAnthropicMessage(toolCallCompletion('{"city":"Bath"}'), 'm');

    expect(message.content).toEqual([{ type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'Bath' } }]);
    expect(message.stop_reason).toBe('tool_use');
  });

  test('malformed tool arguments degrade to {} rather than throwing', () => {
    const message = openAIToAnthropicMessage(toolCallCompletion('{"city": '), 'm');
    expect((message.content[0] as any).input).toEqual({});
  });

  test('an id-less tool call gets a synthesized one', () => {
    const completion = toolCallCompletion('{}');
    delete completion.choices[0].message.tool_calls[0].id;

    const message = openAIToAnthropicMessage(completion, 'm');
    expect((message.content[0] as any).id).toMatch(/^toolu_/);
  });

  test('never claims stop_reason "tool_use" without a tool_use block', () => {
    const completion = toolCallCompletion('{}');
    completion.choices[0].message.tool_calls = [];
    completion.choices[0].message.content = 'never mind';

    const message = openAIToAnthropicMessage(completion, 'm');
    expect(message.stop_reason).toBe('end_turn');
    expect(message.content).toEqual([{ type: 'text', text: 'never mind' }]);
  });

  test('a plain text reply is still exactly one text block', () => {
    const message = openAIToAnthropicMessage(textCompletion('hello'), 'm');
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(message.stop_reason).toBe('end_turn');
  });

  test('text and a tool call come back as two blocks, in order', () => {
    const completion = toolCallCompletion('{"city":"Bath"}');
    completion.choices[0].message.content = 'Checking.';

    const message = openAIToAnthropicMessage(completion, 'm');
    expect(message.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });
});

describe('streamAnthropicMessage', () => {
  test('frames a tool call as tool_use + input_json_delta', () => {
    const frames = captureStream(toolCallCompletion('{"city":"Bath"}'));

    expect(frames.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = frames[1].data;
    expect(start.content_block).toEqual({ type: 'tool_use', id: 'call_abc', name: 'get_weather', input: {} });
    expect(frames[2].data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"city":"Bath"}' });
    expect(frames[4].data.delta.stop_reason).toBe('tool_use');
  });

  test('indexes text and tool blocks separately', () => {
    const completion = toolCallCompletion('{}');
    completion.choices[0].message.content = 'Checking.';
    const frames = captureStream(completion);

    const starts = frames.filter((f) => f.event === 'content_block_start');
    expect(starts.map((f) => [f.data.index, f.data.content_block.type])).toEqual([
      [0, 'text'],
      [1, 'tool_use'],
    ]);
  });

  test('a plain text reply keeps the original six-event sequence', () => {
    const frames = captureStream(textCompletion('hello'));
    expect(frames.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(frames[2].data.delta).toEqual({ type: 'text_delta', text: 'hello' });
  });
});

describe('generation params and token counting', () => {
  test('pickGenerationParams forwards tools but never an empty array', () => {
    expect(pickGenerationParams({ tools: [], tool_choice: 'auto' }).tools).toBeUndefined();
    expect(pickGenerationParams({ tools: [], tool_choice: 'auto' }).tool_choice).toBeUndefined();

    const tools = [{ type: 'function', function: { name: 'x', parameters: {} } }];
    expect(pickGenerationParams({ tools, tool_choice: 'auto' })).toEqual({ tools, tool_choice: 'auto' } as any);
  });

  test('tool schemas and tool calls are counted as input tokens', () => {
    const inputs = [{ role: 'user', content: 'hi' }];
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Look up the weather.', parameters: WEATHER_TOOL.input_schema } }];

    expect(countInputTokens(inputs, tools)).toBeGreaterThan(countInputTokens(inputs));

    const withCall = [
      ...inputs,
      { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bath"}' } }] },
      { role: 'tool', tool_call_id: 't', content: '17C and raining' },
    ];
    expect(countInputTokens(withCall)).toBeGreaterThan(countInputTokens(inputs));
  });
});
