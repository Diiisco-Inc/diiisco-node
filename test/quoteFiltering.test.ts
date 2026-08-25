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
function availability(served: string[]): ModelAvailability & { checks: string[] } {
  const checks: string[] = [];
  return {
    checks,
    list: () => [...served],
    models: () => served.map((id) => ({ id, object: 'model', created: 0, owned_by: 'test' })) as any,
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

function processorWith(models: ModelAvailability) {
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
    { getModels: async () => [], getResponse: async () => ({}) },
    quoteMgr,
    models,
    { emit: () => {} },
    messageRouter,
    'peer-self',
    { peerStore: { merge: async () => {} } }
  );

  return { processor, sent };
}

const quoteRequest = (model: string): QuoteRequest => ({
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

  test('availability is re-checked per request, not read from a snapshot', async () => {
    const models = availability(['gemma3']);
    const { processor } = processorWith(models);

    await processor.process(quoteRequest('gemma3'), 'peer-requester');
    await processor.process(quoteRequest('gemma3'), 'peer-requester');

    expect(models.checks).toEqual(['gemma3', 'gemma3']);
  });
});
