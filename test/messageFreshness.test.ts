/**
 * Replay and identity checks on inbound messages (review L2, L3): a signed
 * message is only honoured near its own timestamp, a broadcast request is
 * handled once, and a node can only describe itself in a network listing.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { configureEnvironment } from '../src/environment/runtime';

const WALLET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeAll(() => {
  configureEnvironment({ local: { enabled: true, privateTopic: 'freshness-test/models/1.0.0' } } as any);
});

function build(signatureValid = () => true) {
  const checks: string[] = [];
  let verifies = 0;
  const events = new EventEmitter();
  const received: any[] = [];
  events.on('network-node-received', (n) => received.push(n));
  const algo: any = {
    account: { addr: { toString: () => WALLET } },
    signObject: async () => 'sig',
    isValidAddress: () => true,
    verifySignature: async () => { verifies += 1; return signatureValid(); },
    nfdVerified: false,
    checkIfOptedInToAsset: async () => ({ optedIn: true, balance: 1n }),
  };
  const models: any = {
    ensureAvailable: async (id: string) => { checks.push(id); return false; },
    list: () => [], models: () => [], kindOf: () => 'chat', isAvailable: () => false, invalidate: () => {},
  };
  const { MessageProcessor } = require('../src/messaging/messageProcessor');
  const quoteEngineModule = require('../src/utils/quoteEngine');
  const processor = new MessageProcessor(
    algo, { getModels: async () => [] }, new quoteEngineModule.default({ emit: () => {} }, algo),
    models, events, { sendMessage: async () => {} }, 'peer-self', { peerStore: { merge: async () => {} } },
  );
  return { processor, checks, verifies: () => verifies, received };
}

const quoteRequest = (id: string, timestamp = Date.now()): any => ({
  role: 'quote-request', id, timestamp, fromWalletAddr: WALLET, signature: 's',
  payload: { model: 'm', inputTokenCount: 1, max_tokens: 1, maxSpend: 1 },
});

describe('timestamp window', () => {
  test('a message inside the window is handled', async () => {
    const { processor, checks } = build();
    await processor.process(quoteRequest('a', Date.now() - 60_000), 'peer-a');
    expect(checks).toEqual(['m']);
  });

  test.each([
    ['an old message', Date.now() - 10 * 60_000],
    ['a message from the future', Date.now() + 10 * 60_000],
    ['no timestamp', undefined],
    ['a non-numeric timestamp', 'yesterday'],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('%s is dropped before its signature is even checked', async (_name, ts) => {
    const { processor, checks, verifies } = build();
    expect(await processor.process({ ...quoteRequest('a'), timestamp: ts }, 'peer-a')).toBe(false);
    expect(verifies()).toBe(0);
    expect(checks).toEqual([]);
  });
});

describe('replay of broadcast requests', () => {
  test('the same request is handled once', async () => {
    const { processor, checks } = build();
    await processor.process(quoteRequest('same'), 'peer-a');
    await processor.process(quoteRequest('same'), 'peer-b'); // replayed by someone else
    expect(checks.length).toBe(1);
  });

  test('a different id is a different request', async () => {
    const { processor, checks } = build();
    await processor.process(quoteRequest('one'), 'peer-a');
    await processor.process(quoteRequest('two'), 'peer-a');
    expect(checks.length).toBe(2);
  });

  test('a forged copy with a bad signature does not use up the real message\'s id', async () => {
    let valid = false;
    const { processor, checks } = build(() => valid);
    await processor.process(quoteRequest('victim'), 'attacker'); // bad signature
    valid = true;
    await processor.process(quoteRequest('victim'), 'victim-peer');
    expect(checks.length).toBe(1);
  });

  test('this node\'s own broadcast is not treated as a replay of itself', async () => {
    const { processor, checks } = build();
    await processor.process(quoteRequest('mine'), 'peer-self');
    await processor.process(quoteRequest('mine'), 'peer-self');
    expect(checks.length).toBe(2);
  });
});

describe('list-network-response identity', () => {
  const listing = (peerId: string): any => ({
    role: 'list-network-response', id: 'l1', to: 'peer-self', timestamp: Date.now(), fromWalletAddr: WALLET, signature: 's',
    payload: { node: { peerId, walletAddr: WALLET, nfd: 'someone.algo', displayName: 'n' } },
  });

  test('a node describing itself is listed', async () => {
    const { processor, received } = build();
    await processor.process(listing('peer-a'), 'peer-a');
    expect(received.map((n) => n.peerId)).toEqual(['peer-a']);
  });

  test('a node announcing another peer\'s id is dropped', async () => {
    const { processor, received } = build();
    await processor.process(listing('peer-victim'), 'peer-a');
    expect(received).toEqual([]);
  });

  test('a listing with no node is dropped, not thrown', async () => {
    const { processor, received } = build();
    const bad = { ...listing('peer-a'), payload: {} };
    await processor.process(bad, 'peer-a');
    expect(received).toEqual([]);
  });
});
