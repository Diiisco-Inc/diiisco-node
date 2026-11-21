/**
 * A fake OpenAI-compatible (optionally Ollama-flavoured) backend for the
 * performance tests (plan 018). Streams SSE chat completions with controllable
 * delays, and answers the few Ollama-native endpoints the node uses.
 */

export interface StubChunk {
  content?: string;
  reasoning?: string;
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
}

export interface StubBehaviour {
  /** Delay before the first output chunk, ms. */
  firstTokenDelayMs?: number;
  /** Delay between later chunks, ms. */
  interChunkDelayMs?: number;
  chunks?: StubChunk[];
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  /** Answer `stream: true` with this HTTP status (e.g. 400) instead of streaming. */
  rejectStreamStatus?: number;
  /** Close the stream after this many chunks without finishing (a mid-stream failure). */
  dieAfterChunks?: number;
  /** Speak the Ollama-native endpoints. */
  ollama?: boolean;
  /** Never answer chat requests (a hung backend). */
  hang?: boolean;
}

export interface StubBackend {
  url: string;          // e.g. http://127.0.0.1:1234
  port: number;
  behaviour: StubBehaviour;
  requests: { stream: boolean; body: any }[];
  loaded: Set<string>;
  digests: Map<string, string>;
  unloads: string[];
  stop(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wholeMessage(b: StubBehaviour) {
  const chunks = b.chunks ?? [];
  const content = chunks.map((c) => c.content ?? '').join('');
  const reasoning = chunks.map((c) => c.reasoning ?? '').join('');
  const calls: any[] = [];
  for (const c of chunks) {
    for (const t of c.toolCalls ?? []) {
      const slot = (calls[t.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (t.id) slot.id = t.id;
      if (t.name) slot.function.name = t.name;
      slot.function.arguments += t.arguments ?? '';
    }
  }
  return {
    role: 'assistant',
    content,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

export function startStubBackend(behaviour: StubBehaviour = {}): StubBackend {
  const state: Omit<StubBackend, 'url' | 'port' | 'stop'> = {
    behaviour,
    requests: [],
    loaded: new Set(),
    digests: new Map(),
    unloads: [],
  };

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const b = state.behaviour;

      if (b.ollama) {
        if (url.pathname === '/api/version') return Response.json({ version: '0.12.0' });
        if (url.pathname === '/api/ps') return Response.json({ models: [...state.loaded].map((name) => ({ name, model: name })) });
        if (url.pathname === '/api/tags') {
          return Response.json({ models: [...state.digests].map(([name, digest]) => ({ name, model: name, digest })) });
        }
        if (url.pathname === '/api/generate') {
          const body = await req.json();
          if (body.keep_alive === 0) {
            state.unloads.push(body.model);
            state.loaded.delete(body.model);
          }
          return Response.json({ done: true });
        }
      }

      if (url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [{ id: 'stub-model', object: 'model', created: 0, owned_by: 'stub' }] });
      }

      if (url.pathname === '/v1/systemone') {
        const body = await req.json();
        state.requests.push({ stream: false, body });
        if (b.hang) {
          await new Promise((resolve) => req.signal.addEventListener('abort', resolve));
          return new Response('aborted', { status: 499 });
        }
        state.loaded.add(body.model);
        await sleep(b.firstTokenDelayMs ?? 0);
        const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((id) => [id, { type: 'choice', choice: 'negative' }]));
        return Response.json({ model: body.model, answers, usage: { input_tokens: 30, output_tokens: 2 } });
      }

      if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });

      const body = await req.json();
      const stream = body.stream === true;
      state.requests.push({ stream, body });
      if (b.hang) {
        await new Promise((resolve) => req.signal.addEventListener('abort', resolve));
        return new Response('aborted', { status: 499 });
      }
      if (stream && b.rejectStreamStatus) {
        return Response.json({ error: { message: 'streaming is not supported' } }, { status: b.rejectStreamStatus });
      }

      state.loaded.add(body.model);
      const usage = b.usage === undefined ? { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 } : b.usage;
      const base = { id: 'chatcmpl-stub', created: 1700000000, model: body.model };

      if (!stream) {
        await sleep(b.firstTokenDelayMs ?? 0);
        return Response.json({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: wholeMessage(b), finish_reason: b.finishReason ?? 'stop', logprobs: null }],
          ...(usage ? { usage } : {}),
        });
      }

      const encoder = new TextEncoder();
      const send = (controller: ReadableStreamDefaultController, data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const readable = new ReadableStream({
        async start(controller) {
          const chunks = b.chunks ?? [];
          // A role-only chunk first, as real runtimes send: it carries no output.
          send(controller, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          await sleep(b.firstTokenDelayMs ?? 0);
          for (let i = 0; i < chunks.length; i++) {
            if (b.dieAfterChunks !== undefined && i >= b.dieAfterChunks) {
              controller.error(new Error('backend died'));
              return;
            }
            if (i > 0) await sleep(b.interChunkDelayMs ?? 0);
            const c = chunks[i];
            const delta: any = {};
            if (c.content !== undefined) delta.content = c.content;
            if (c.reasoning !== undefined) delta.reasoning_content = c.reasoning;
            if (c.toolCalls) {
              delta.tool_calls = c.toolCalls.map((t) => ({
                index: t.index,
                ...(t.id ? { id: t.id, type: 'function' } : {}),
                function: { ...(t.name ? { name: t.name } : {}), ...(t.arguments !== undefined ? { arguments: t.arguments } : {}) },
              }));
            }
            send(controller, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] });
          }
          send(controller, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: b.finishReason ?? 'stop' }] });
          if (usage && body.stream_options?.include_usage) {
            send(controller, { ...base, object: 'chat.completion.chunk', choices: [], usage });
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(readable, { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  return {
    ...state,
    get behaviour() { return state.behaviour; },
    set behaviour(v: StubBehaviour) { state.behaviour = v; },
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    stop: () => server.stop(true),
  } as StubBackend;
}

/** `n` text chunks of one word each. */
export const words = (n: number): StubChunk[] => Array.from({ length: n }, (_, i) => ({ content: `w${i} ` }));
