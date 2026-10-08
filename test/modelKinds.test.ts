/**
 * Model kind detection (`src/utils/modelCapabilities.ts`).
 *
 * Embedding and decision models were listed beside chat models because
 * `/v1/models` carries no type. DIIISCO fronts any OpenAI-compatible runtime, so
 * detection is a pipeline of sources rather than one runtime's API; these tests
 * pin the precedence between them, the Ollama and LM Studio dialects, and the
 * fail-open behaviour for a backend that says nothing at all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NO_BINARY_REASON, binary, forceStop, freePort, makeHome, removeHome, run, writeOfflineConfig } from './helpers';
import {
  ModelKindDetector,
  filterModelsByKind,
  kindFromCapabilities,
  kindFromEntry,
  kindFromName,
  kindFromTypeString,
  normalizeKind,
  parseKindFilter,
} from '../src/utils/modelCapabilities';

const model = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, object: 'model', created: 1, owned_by: 'test', ...extra }) as any;

/** A fetch stand-in that serves canned JSON by path, 404s the rest, and counts calls. */
function fakeFetch(routes: Record<string, unknown>, options: { throwOn?: string[] } = {}) {
  const calls: string[] = [];
  const impl = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (options.throwOn?.includes(path)) throw new Error('connection reset');
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const detector = (fetchImpl: typeof fetch, overrides?: Record<string, any>) =>
  new ModelKindDetector({ baseURL: 'http://localhost', port: 11434, overrides, fetch: fetchImpl });

const kinds = (list: Array<{ id: string; kind?: string }>) => Object.fromEntries(list.map((m) => [m.id, m.kind]));

// Captured from a local Ollama 0.35.0 `/api/tags`.
const OLLAMA_TAGS = {
  models: [
    { name: 'tev1:0.8b', capabilities: ['decision', 'tools', 'thinking', 'completion'], details: { family: 'qwen35' } },
    { name: 'embeddinggemma:latest', capabilities: ['embedding'], details: { family: 'gemma3', families: ['gemma3'] } },
    { name: 'gemma4:12b', capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'], details: { family: 'gemma4' } },
  ],
};
const OLLAMA_MODELS = [model('tev1:0.8b'), model('embeddinggemma:latest'), model('gemma4:12b')];

describe('kindFromCapabilities', () => {
  test.each([
    [['embedding'], 'embedding'],
    [['completion', 'vision', 'tools'], 'chat'],
    // Ollama lists `completion` on decision models too — decision must win.
    [['decision', 'tools', 'thinking', 'completion'], 'decision'],
    [['embeddings'], 'embedding'],
    [['COMPLETION'], 'chat'],
    // Something that both embeds and completes is a chat model.
    [['embedding', 'completion'], 'chat'],
    [[], null],
    [['rerank'], null],
  ])('%j → %p', (capabilities, expected) => {
    expect(kindFromCapabilities(capabilities as string[])).toBe(expected as any);
  });
});

describe('what a /v1/models entry says about itself', () => {
  test('type-ish strings', () => {
    expect(kindFromTypeString('embeddings')).toBe('embedding');
    expect(kindFromTypeString('llm')).toBe('chat');
    expect(kindFromTypeString('vlm')).toBe('chat');
    expect(kindFromTypeString('decision')).toBe('decision');
    expect(kindFromTypeString('rerank')).toBeNull();
    expect(kindFromTypeString(42)).toBeNull();
  });

  test('entries are read for capabilities, type fields and output modalities', () => {
    expect(kindFromEntry({ id: 'a', capabilities: ['embedding'] })?.kind).toBe('embedding');
    expect(kindFromEntry({ id: 'a', mode: 'embedding' })?.kind).toBe('embedding');
    expect(kindFromEntry({ id: 'a', architecture: { output_modalities: ['embeddings'] } })?.kind).toBe('embedding');
    expect(kindFromEntry({ id: 'a', owned_by: 'x' })).toBeNull();
  });

  test('name hints only ever guess embedding', () => {
    expect(kindFromName('nomic-embed-text')).toBe('embedding');
    expect(kindFromName('bge-m3')).toBe('embedding');
    expect(kindFromName('tev1:0.8b')).toBeNull();
    expect(kindFromName('gemma4:12b')).toBeNull();
  });
});

describe('ModelKindDetector', () => {
  test('classifies from Ollama /api/tags and keeps the raw capabilities', async () => {
    const { fetch } = fakeFetch({ '/api/tags': OLLAMA_TAGS });

    const result = await detector(fetch).classify(OLLAMA_MODELS, 2000);

    expect(kinds(result)).toEqual({
      'tev1:0.8b': 'decision',
      'embeddinggemma:latest': 'embedding',
      'gemma4:12b': 'chat',
    });
    expect(result[0].capabilities).toContain('decision');
  });

  test('reads LM Studio when the runtime is not Ollama', async () => {
    const { fetch } = fakeFetch({
      '/api/v0/models': { data: [{ id: 'qwen', type: 'llm' }, { id: 'nomic', type: 'embeddings' }] },
    });

    const result = await detector(fetch).classify([model('qwen'), model('nomic')], 2000);

    expect(kinds(result)).toEqual({ qwen: 'chat', nomic: 'embedding' });
  });

  test('an entry that describes itself needs no request', async () => {
    const { fetch, calls } = fakeFetch({ '/api/tags': OLLAMA_TAGS });

    const result = await detector(fetch).classify([model('custom', { type: 'embedding' })], 2000);

    expect(kinds(result)).toEqual({ custom: 'embedding' });
    expect(calls).toEqual([]);
  });

  test('the operator override beats what the runtime reports, by id and by glob', async () => {
    const { fetch } = fakeFetch({ '/api/tags': OLLAMA_TAGS });
    const overrides = { 'gemma4:12b': 'decision', 'embeddinggemma*': 'chat' };

    const result = await detector(fetch, overrides).classify(OLLAMA_MODELS, 2000);

    expect(kinds(result)).toEqual({
      'tev1:0.8b': 'decision',
      'embeddinggemma:latest': 'chat',
      'gemma4:12b': 'decision',
    });
  });

  test('a runtime that says nothing leaves every model as chat, and a name hint still applies', async () => {
    const { fetch } = fakeFetch({}); // vLLM, llama.cpp, a hosted gateway: no dialect we know

    const result = await detector(fetch).classify([model('llama-3'), model('tev1:0.8b'), model('nomic-embed-text')], 2000);

    expect(kinds(result)).toEqual({ 'llama-3': 'chat', 'tev1:0.8b': 'chat', 'nomic-embed-text': 'embedding' });
  });

  test('an override is how a silent runtime gets a decision model recognised', async () => {
    const { fetch } = fakeFetch({});

    const result = await detector(fetch, { 'tev1:*': 'decision' }).classify([model('tev1:0.8b')], 2000);

    expect(kinds(result)).toEqual({ 'tev1:0.8b': 'decision' });
  });

  test('a dialect that found nothing is not asked again on every poll', async () => {
    const { fetch, calls } = fakeFetch({});
    const d = detector(fetch);

    await d.classify([model('a')], 2000);
    const firstRound = calls.length;
    expect(firstRound).toBeGreaterThan(0);

    // A different model forces a fresh look; the probing sources are backed off.
    await d.classify([model('b')], 2000);
    expect(calls.length).toBe(firstRound);
  });

  test('a transient failure is retried rather than remembered', async () => {
    const { fetch, calls } = fakeFetch({ '/api/tags': OLLAMA_TAGS }, { throwOn: ['/api/tags'] });
    const d = detector(fetch);

    const first = await d.classify(OLLAMA_MODELS, 2000);
    // Fail open: with /api/tags down, a decision model is offered as chat rather than hidden.
    expect(kinds(first)['tev1:0.8b']).toBe('chat');
    const before = calls.filter((p) => p === '/api/tags').length;

    await d.classify(OLLAMA_MODELS, 2000);
    expect(calls.filter((p) => p === '/api/tags').length).toBeGreaterThan(before);
  });

  test('answers are cached while the model list is unchanged', async () => {
    const { fetch, calls } = fakeFetch({ '/api/tags': OLLAMA_TAGS });
    const d = detector(fetch);

    await d.classify(OLLAMA_MODELS, 2000);
    const after = calls.length;
    const again = await d.classify(OLLAMA_MODELS, 2000);

    expect(calls.length).toBe(after);
    expect(kinds(again)['tev1:0.8b']).toBe('decision');
  });

  test('never throws, even when the backend is unreachable', async () => {
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;

    const result = await detector(failing).classify([model('a'), model('b')], 2000);

    expect(kinds(result)).toEqual({ a: 'chat', b: 'chat' });
  });
});

describe('reading kinds off a listing', () => {
  const listing = [
    { id: 'chatty' },
    { id: 'chatty-2', kind: 'chat' },
    { id: 'vec', kind: 'embedding' },
    { id: 'dec', kind: 'decision' },
    { id: 'weird', kind: 'something-a-peer-invented' },
  ];

  test('no `type` means chat, and an entry from an older node (no kind) counts as chat', () => {
    expect(parseKindFilter(undefined)).toBe('chat');
    expect(filterModelsByKind(listing, 'chat').map((m) => m.id)).toEqual(['chatty', 'chatty-2', 'weird']);
  });

  test('`type` selects a kind, or everything', () => {
    expect(filterModelsByKind(listing, parseKindFilter('embedding')!).map((m) => m.id)).toEqual(['vec']);
    expect(filterModelsByKind(listing, parseKindFilter('decision')!).map((m) => m.id)).toEqual(['dec']);
    expect(filterModelsByKind(listing, parseKindFilter('ALL')!)).toHaveLength(5);
  });

  test('an unrecognised `type` is rejected, and unknown kinds from peers read as chat', () => {
    expect(parseKindFilter('image')).toBeNull();
    expect(parseKindFilter(['chat'])).toBeNull();
    expect(normalizeKind('image')).toBe('chat');
  });
});

const suite = binary ? describe : describe.skip;
if (!binary) console.warn(`skipping modelKinds.test.ts (binary suite): ${NO_BINARY_REASON}`);

suite('compiled binary — /v1/models type filter', () => {
  let home: string;
  let base: string;

  beforeAll(async () => {
    home = makeHome('diiisco-kinds-');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    writeOfflineConfig(home, port);
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
  }, 90_000);

  afterAll(() => {
    forceStop(home);
    removeHome(home);
  });

  test('an unrecognised type is a 400, not an empty list', async () => {
    const response = await fetch(`${base}/v1/models?type=image`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('chat, embedding, decision, all');
  }, 30_000);

  test('the default, a specific type and `all` are all accepted', async () => {
    for (const query of ['', '?type=chat', '?type=embedding', '?type=decision', '?type=all']) {
      const response = await fetch(`${base}/v1/models${query}`);
      expect(`${query} -> ${response.status}`).toBe(`${query} -> 200`);
      expect((await response.json()).object).toBe('list');
    }
  }, 90_000);
});
