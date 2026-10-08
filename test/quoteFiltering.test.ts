/**
 * The quoting stage's model filter (`MessageProcessor.handleQuoteRequest`).
 *
 * This is the acceptance criterion of the "node quotes for models it can no
 * longer serve" bug, asserted directly: a node whose inference backend has
 * stopped must fall silent in the auction rather than win it and hang the
 * requester. Run against the source, with the backend, the wallet and the
 * transport all stubbed — there is no way to observe this from the CLI.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { configureEnvironment } from '../src/environment/runtime';
import type { ModelAvailability } from '../src/utils/modelAvailability';
import type { QuoteRequest, PubSubMessage } from '../src/types/messages';

// Local mode keeps the processor off Algorand entirely: no settlement provider
// to register, no opt-in check between the model filter and the quote.
beforeAll(() => {
  configureEnvironment({ local: { enabled: true, privateTopic: 'quote-filter-test/models/1.0.0' } });
});

/** Availability stub: reports exactly the ids it is given, and counts checks. */
function availability(served: string[], kinds: Record<string, string> = {}): ModelAvailability & { checks: string[] } {
  const checks: string[] = [];
  return {
    checks,
    list: () => [...served],
    models: () => served.map((id) => ({ id, object: 'model', created: 0, owned_by: 'test' })) as any,
    kindOf: (id: string) => (kinds[id] ?? 'chat') as any,
    isChat: (id: string) => (kinds[id] ?? 'chat') === 'chat',
    isAvailable: (id: string) => served.includes(id),
    ensureAvailable: async (id: string) => { checks.push(id); return served.includes(id); },
    refresh: async () => [...served],
    isHealthy: () => served.length > 0,
    invalidate: () => {},
    start: () => {},
    stop: () => {},
  };
}

const WALLET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function processorWith(models: ModelAvailability, backend: Record<string, any> = { getModels: async () => [], getResponse: async () => ({}) }) {
  const sent: PubSubMessage[] = [];
  const messageRouter = { sendMessage: async (msg: PubSubMessage) => { sent.push(msg); } };
  const algo = {
    account: { addr: { toString: () => WALLET } },
    signObject: async () => 'signature',
    isValidAddress: () => true,
    verifySignature: async () => true,
    nfdVerified: false,
    checkIfOptedInToAsset: async () => ({ optedIn: true, balance: 1n }),
  };

  // Imported lazily so `configureEnvironment` above lands before the module
  // graph reads the singleton.
  const { MessageProcessor } = require('../src/messaging/messageProcessor');
  const quoteEngineModule = require('../src/utils/quoteEngine');
  const quoteMgr = new quoteEngineModule.default({ emit: () => {} }, algo);

  const processor = new MessageProcessor(
    algo,
    backend,
    quoteMgr,
    models,
    { emit: () => {} },
    messageRouter,
    'peer-self',
    { peerStore: { merge: async () => {} } }
  );

  return { processor, sent };
}

const quoteRequest = (model: string, kind?: 'systemone'): QuoteRequest => ({
  role: 'quote-request',
  from: 'peer-requester',
  fromWalletAddr: WALLET,
  timestamp: Date.now(),
  id: 'request-1',
  payload: {
    model,
    inputTokenCount: 100,
    max_tokens: 256,
    maxSpend: 0.05,
    ...(kind ? { kind } : {}),
  },
  // `process()` verifies before it routes; the stub wallet accepts anything.
  signature: 'signature',
});

describe('quote filtering by live model availability', () => {
  test('a model the backend no longer serves is not quoted', async () => {
    const models = availability([]); // backend stopped: nothing is served
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('gemma3'), 'peer-requester');

    expect(sent).toEqual([]);
    expect(models.checks).toEqual(['gemma3']);
  });

  test('a model the backend still serves is quoted', async () => {
    const models = availability(['gemma3']);
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('gemma3'), 'peer-requester');

    expect(sent.length).toBe(1);
    expect(sent[0].role).toBe('quote-response');
    expect((sent[0] as any).payload.quote.model).toBe('gemma3');
  });

  test('a model this node never served is not quoted', async () => {
    const models = availability(['gemma3']);
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('llama3'), 'peer-requester');

    expect(sent).toEqual([]);
  });

  test('an embedding model is not quoted for a chat request', async () => {
    const models = availability(['embeddinggemma'], { embeddinggemma: 'embedding' });
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('embeddinggemma'), 'peer-requester');

    expect(sent).toEqual([]);
  });

  test('a decision model is not quoted for a chat request', async () => {
    const models = availability(['tev1:0.8b'], { 'tev1:0.8b': 'decision' });
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('tev1:0.8b'), 'peer-requester');

    expect(sent).toEqual([]);
  });

  test('availability is re-checked per request, not read from a snapshot', async () => {
    const models = availability(['gemma3']);
    const { processor } = processorWith(models);

    await processor.process(quoteRequest('gemma3'), 'peer-requester');
    await processor.process(quoteRequest('gemma3'), 'peer-requester');

    expect(models.checks).toEqual(['gemma3', 'gemma3']);
  });
});


describe('System One requests', () => {
  test('a decision model quotes for a System One request', async () => {
    const models = availability(['tev1:0.8b'], { 'tev1:0.8b': 'decision' });
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('tev1:0.8b', 'systemone'), 'peer-requester');

    expect(sent.length).toBe(1);
    expect(sent[0].role).toBe('quote-response');
    // The kind rides back on the quote, so the requester's acceptance carries it.
    expect((sent[0] as any).payload.kind).toBe('systemone');
  });

  test('a chat model does not quote for a System One request', async () => {
    const models = availability(['gemma3']);
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('gemma3', 'systemone'), 'peer-requester');

    expect(sent).toEqual([]);
  });

  test('an embedding model does not quote for a System One request', async () => {
    const models = availability(['embeddinggemma'], { embeddinggemma: 'embedding' });
    const { processor, sent } = processorWith(models);

    await processor.process(quoteRequest('embeddinggemma', 'systemone'), 'peer-requester');

    expect(sent).toEqual([]);
  });
});

const NOUL_REQUEST = {
  model: 'tev1:0.8b',
  kind: 'systemone',
  state: 'Help! My payouts have been failing for 3 days.',
  questions: { is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' } },
};
const NOUL_ANSWER = {
  model: 'tev1:0.8b',
  answers: { is_urgent: { type: 'noul', noul: 0.88 } },
  usage: { input_tokens: 119, output_tokens: 1 },
};

const quoteAccepted = (payload: Record<string, unknown>) => ({
  role: 'quote-accepted',
  to: 'peer-self',
  timestamp: Date.now(),
  id: 'accepted-1',
  fromWalletAddr: WALLET,
  payload,
  signature: 'signature',
}) as any;

describe('serving an accepted System One quote', () => {
  test('runs the questions on the backend and returns its answer unchanged', async () => {
    const calls: any[] = [];
    const backend = {
      getModels: async () => [],
      getResponse: async () => { throw new Error('a System One request must not be run as a chat completion'); },
      systemOne: async (request: any) => { calls.push(request); return NOUL_ANSWER; },
    };
    const models = availability(['tev1:0.8b'], { 'tev1:0.8b': 'decision' });
    const { processor, sent } = processorWith(models, backend);

    await processor.process(quoteAccepted(NOUL_REQUEST), 'peer-requester');

    expect(calls).toEqual([{ model: 'tev1:0.8b', state: NOUL_REQUEST.state, questions: NOUL_REQUEST.questions }]);
    expect(sent.length).toBe(1);
    expect(sent[0].role).toBe('inference-response');
    expect((sent[0] as any).payload.completion).toEqual(NOUL_ANSWER);
  });

  test('a chat model asked a System One question never reaches the backend', async () => {
    let touched = false;
    const backend = {
      getModels: async () => [],
      getResponse: async () => { touched = true; return {}; },
      systemOne: async () => { touched = true; return {}; },
    };
    const models = availability(['gemma3']);
    const { processor, sent } = processorWith(models, backend);

    await processor.process(quoteAccepted({ ...NOUL_REQUEST, model: 'gemma3' }), 'peer-requester');

    expect(touched).toBe(false);
    expect(sent.map((m) => m.role)).toEqual(['inference-failed']);
  });

  test('a malformed question set is refused rather than forwarded', async () => {
    let touched = false;
    const backend = { getModels: async () => [], systemOne: async () => { touched = true; return {}; } };
    const models = availability(['tev1:0.8b'], { 'tev1:0.8b': 'decision' });
    const { processor, sent } = processorWith(models, backend);

    await processor.process(quoteAccepted({ ...NOUL_REQUEST, questions: {} }), 'peer-requester');

    expect(touched).toBe(false);
    expect(sent.map((m) => m.role)).toEqual(['inference-failed']);
  });

  test('a backend that rejects the request is reported as a failure, not a hang', async () => {
    const backend = {
      getModels: async () => [],
      systemOne: async () => { throw new Error('model is not supported by System One'); },
    };
    const models = availability(['tev1:0.8b'], { 'tev1:0.8b': 'decision' });
    const { processor, sent } = processorWith(models, backend);

    await processor.process(quoteAccepted(NOUL_REQUEST), 'peer-requester');

    expect(sent.map((m) => m.role)).toEqual(['inference-failed']);
  });
});
