/**
 * Who may be paid, and who may be believed (release/1.0.9 review, plan 011).
 *
 * Both sides of an x402 settlement used to trust values the other side wrote.
 * These tests drive `MessageProcessor` and `X402Settlement` directly, with the
 * backend, the wallet signature and the transport stubbed, and assert the
 * rules that replaced that trust:
 *
 *  - a provider honours an accept only for a quote it issued to *that peer*,
 *    prices it at its *own* rates, and holds the payment to the requirements it
 *    issued — once;
 *  - a requester signs a payment only for a request it made, when asked by the
 *    provider it chose, in USDC on its own network, to that provider's wallet.
 *
 * Identity throughout is the peer id the transport reports, never a wallet:
 * the nodes in these tests deliberately share one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import algosdk from 'algosdk';
import environment from '../src/environment/runtime';
import type { PubSubMessage } from '../src/types/messages';
import { RequestLedger } from '../src/messaging/requestLedger';
import { paymentTransactionId, requirementsMismatch } from '../src/settlement/x402Settlement';

// One wallet for every node in these tests: peer ids, not wallets, must tell
// them apart.
const account = algosdk.generateAccount();
const WALLET = account.addr.toString();

const PROVIDER = 'peer-provider';
const REQUESTER = 'peer-requester';
const STRANGER = 'peer-stranger';

// 100 USDC per 1M tokens in both directions: a 10 + 5 token completion costs
// 15 / 1e6 * 100 = 0.0015 USDC = 1500 µUSDC, far from the 1 µUSDC floor.
const RATE = 100;
const COMPLETION = {
  choices: [{ message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const saved = { local: environment.local, algorand: environment.algorand, charge: environment.models.chargePer1MTokens };

beforeAll(() => {
  environment.local = { enabled: false };
  environment.algorand = {
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
    network: 'mainnet',
    client: { address: 'http://127.0.0.1', port: 1, token: '' },
    settlement: { methods: ['x402'], maxSpend: 0.1 },
  };
  environment.models.chargePer1MTokens = { default: { input: RATE, output: RATE } };
});

afterAll(() => {
  environment.local = saved.local;
  environment.algorand = saved.algorand;
  environment.models.chargePer1MTokens = saved.charge;
});

function harness(ledger = new RequestLedger()) {
  const sent: any[] = [];
  const events = new EventEmitter();
  const messageRouter = { sendMessage: async (msg: PubSubMessage) => { sent.push(msg); } };
  const algo = {
    account,
    signObject: async () => 'signature',
    isValidAddress: () => true,
    verifySignature: async () => true,
    nfdVerified: false,
    checkIfOptedInToAsset: async () => ({ optedIn: true, balance: 1n }),
  };
  const backend = { getModels: async () => [], getResponse: async () => COMPLETION };
  const models: any = {
    list: () => ['gemma3'],
    models: () => [],
    kindOf: () => 'chat',
    isChat: () => true,
    isAvailable: () => true,
    ensureAvailable: async () => true,
    refresh: async () => ['gemma3'],
    isHealthy: () => true,
    invalidate: () => {},
    start: () => {},
    stop: () => {},
  };

  const { MessageProcessor } = require('../src/messaging/messageProcessor');
  const quoteEngineModule = require('../src/utils/quoteEngine');
  const quoteMgr = new quoteEngineModule.default({ emit: () => {} }, algo);
  const processor = new MessageProcessor(
    algo, backend, quoteMgr, models, events, messageRouter, 'peer-self',
    { peerStore: { merge: async () => {} } }, ledger
  );
  const roles = () => sent.map((m) => m.role);
  return { processor, sent, roles, events, ledger };
}

const message = (role: string, id: string, extra: Record<string, unknown> = {}): any => ({
  role, id, timestamp: Date.now(), fromWalletAddr: WALLET, signature: 'signature', ...extra,
});

const quoteRequest = () => message('quote-request', 'req-1', {
  from: REQUESTER,
  payload: { model: 'gemma3', inputTokenCount: 100, max_tokens: 256, maxSpend: 0.05 },
});

// What a requester that lies sends: zero rates, a huge budget, a made-up quote.
const dishonestAccept = (id = 'req-1') => message('quote-accepted', id, {
  to: 'peer-self',
  payload: {
    model: 'gemma3',
    inputs: [{ role: 'user', content: 'hello' }],
    max_tokens: 256,
    maxSpend: 999,
    quote: { pricePerInputToken1M: 0, pricePerOutputToken1M: 0 },
  },
});

/** A provider that has quoted REQUESTER and been accepted by it; returns the challenge it issued. */
async function acceptedProvider() {
  const h = harness();
  await h.processor.process(quoteRequest(), REQUESTER);
  await h.processor.process(dishonestAccept(), REQUESTER);
  const challenge = h.sent.find((m) => m.role === 'contract-created');
  return { ...h, challenge };
}

describe('provider: accepting a quote', () => {
  test('bills at its own rates, not the zero rates the requester echoes', async () => {
    const { challenge } = await acceptedProvider();
    expect(challenge).toBeDefined();
    expect(challenge.payload.paymentRequirements.amount).toBe('1500');
    expect(challenge.payload.paymentRequirements.payTo).toBe(WALLET);
  });

  test('ignores an accept for a quote it never issued', async () => {
    const h = harness();
    await h.processor.process(dishonestAccept(), REQUESTER);
    expect(h.sent).toEqual([]);
  });

  test('ignores an accept from a peer other than the one it quoted', async () => {
    const h = harness();
    await h.processor.process(quoteRequest(), REQUESTER);
    h.sent.length = 0;
    await h.processor.process(dishonestAccept(), STRANGER);
    expect(h.sent).toEqual([]);
    // ...and the stranger did not burn the real requester's quote.
    await h.processor.process(dishonestAccept(), REQUESTER);
    expect(h.roles()).toEqual(['contract-created']);
  });

  test('a quote is spent by its accept: a replayed accept does no second inference', async () => {
    const h = harness();
    await h.processor.process(quoteRequest(), REQUESTER);
    await h.processor.process(dishonestAccept(), REQUESTER);
    await h.processor.process(dishonestAccept(), REQUESTER);
    expect(h.roles().filter((r: string) => r === 'contract-created').length).toBe(1);
  });

  test('refuses an accept that swaps in a different model than was quoted', async () => {
    const h = harness();
    await h.processor.process(quoteRequest(), REQUESTER);
    h.sent.length = 0;
    const swapped = dishonestAccept();
    swapped.payload.model = 'a-much-bigger-model';
    await h.processor.process(swapped, REQUESTER);
    expect(h.sent).toEqual([]);
  });
});

describe('provider: contract-signed', () => {
  const signed = (evidence: unknown) => message('contract-signed', 'req-1', {
    to: 'peer-self',
    payload: { paymentPayload: evidence, maxSpend: 999 },
  });

  /** An accepted provider whose facilitator verdict is `verdict`; records what it was asked to verify. */
  async function providerWithVerdict(verdict: boolean) {
    const h = await acceptedProvider();
    const stub = Object.create((h.processor as any).settlement.get('x402'));
    const verified: any[] = [];
    stub.verifyPayment = async (args: any) => { verified.push(args); return { ok: verdict, amount: 1500n }; };
    stub.settle = async () => ({ txid: 'txid' });
    (h.processor as any).settlement.register(stub);
    h.sent.length = 0;
    return { ...h, verified };
  }

  test('without a challenge nothing is verified, run or released', async () => {
    const h = harness();
    const stub = Object.create((h.processor as any).settlement.get('x402'));
    let verified = 0;
    stub.verifyPayment = async () => { verified++; return { ok: true, amount: 0n }; };
    (h.processor as any).settlement.register(stub);

    await h.processor.process(signed({}), REQUESTER);
    expect(verified).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test('releases the withheld answer to the peer it was computed for, once the payment verifies', async () => {
    const { processor, sent } = await providerWithVerdict(true);
    await processor.process(signed({}), REQUESTER);
    expect(sent.map((m: any) => m.role)).toEqual(['inference-response']);
    expect(sent[0].payload.completion).toEqual(COMPLETION);
    expect(sent[0].to).toBe(REQUESTER);
  });

  test('verifies against the requirements it issued, not the ones the requester says it paid', async () => {
    const { processor, verified, challenge } = await providerWithVerdict(true);
    const cheaper = { ...challenge.payload.paymentRequirements, amount: '1', asset: '1' };
    await processor.process(signed({ accepted: cheaper }), REQUESTER);
    expect(verified.length).toBe(1);
    expect(verified[0].expected).toEqual(challenge.payload.paymentRequirements);
    expect(verified[0].expected.amount).toBe('1500');
  });

  test('from a peer other than the one challenged is ignored, and leaves the challenge usable', async () => {
    const { processor, sent, verified } = await providerWithVerdict(true);
    await processor.process(signed({}), STRANGER);
    expect(verified.length).toBe(0);
    expect(sent).toEqual([]);

    await processor.process(signed({}), REQUESTER);
    expect(sent.map((m: any) => m.role)).toEqual(['inference-response']);
  });

  test('is single-use: a replay finds no challenge and releases nothing', async () => {
    const { processor, sent, verified } = await providerWithVerdict(true);
    await processor.process(signed({}), REQUESTER);
    sent.length = 0;
    await processor.process(signed({}), REQUESTER);
    expect(verified.length).toBe(1);
    expect(sent).toEqual([]);
  });

  test('a payment that does not verify releases nothing, and burns the challenge', async () => {
    const { processor, sent } = await providerWithVerdict(false);
    await processor.process(signed({}), REQUESTER);
    expect(sent).toEqual([]);
  });

  test('the real settlement refuses a payment for other requirements before it reaches the facilitator', async () => {
    const { processor, sent, challenge } = await acceptedProvider();
    sent.length = 0;
    const cheaper = { ...challenge.payload.paymentRequirements, amount: '1' };
    await processor.process(signed({ accepted: cheaper, payload: {} }), REQUESTER);
    expect(sent).toEqual([]);
  });
});

describe('requester: contract-created', () => {
  /** A requester whose request went to PROVIDER, paying PROVIDER_WALLET; `pay` is stubbed (it would call algod). */
  async function requesterWith(options: { select?: boolean } = {}) {
    const h = harness();
    const real = (h.processor as any).settlement.get('x402');
    const stub = Object.create(real);
    let paid = 0;
    stub.pay = async () => { paid++; return { stub: true }; };
    (h.processor as any).settlement.register(stub);
    if (options.select !== false) h.ledger.select('req-1', { peerId: PROVIDER, payTo: WALLET }, 60_000);
    const request = await real.createPaymentRequest({ quoteId: 'req-1', amount: 1500n });
    const challenge = (overrides: Record<string, unknown> = {}) => message('contract-created', 'req-1', {
      to: 'peer-self', payload: { paymentRequirements: { ...request, ...overrides } },
    });
    return { ...h, challenge, paid: () => paid, request };
  }

  test('signs for the provider it chose', async () => {
    const r = await requesterWith();
    await r.processor.process(r.challenge(), PROVIDER);
    expect(r.roles()).toEqual(['contract-signed']);
    expect(r.paid()).toBe(1);
  });

  test('refuses a request it never made', async () => {
    const r = await requesterWith({ select: false });
    await r.processor.process(r.challenge(), PROVIDER);
    expect(r.sent).toEqual([]);
    expect(r.paid()).toBe(0);
  });

  test('refuses a payment request from a bystander, even one that shares the provider wallet', async () => {
    const r = await requesterWith();
    await r.processor.process(r.challenge(), STRANGER);
    expect(r.sent).toEqual([]);
    expect(r.paid()).toBe(0);
  });

  test('refuses to pay anyone but the wallet that signed the quote', async () => {
    const r = await requesterWith();
    await r.processor.process(r.challenge({ payTo: algosdk.generateAccount().addr.toString() }), PROVIDER);
    expect(r.paid()).toBe(0);
  });

  test('refuses another asset and another network', async () => {
    const r = await requesterWith();
    await r.processor.process(r.challenge({ asset: '1' }), PROVIDER);
    await r.processor.process(r.challenge({ network: 'algorand:somewhere-else' }), PROVIDER);
    expect(r.paid()).toBe(0);
  });

  test('refuses fee-payer sponsorship and a non-integer amount', async () => {
    const r = await requesterWith();
    await r.processor.process(r.challenge({ extra: { feePayer: WALLET } }), PROVIDER);
    await r.processor.process(r.challenge({ amount: '1e9' }), PROVIDER);
    await r.processor.process(r.challenge({ amount: '-5' }), PROVIDER);
    expect(r.paid()).toBe(0);
  });

  test('refuses an amount above its own maxSpend (0.1 USDC)', async () => {
    const r = await requesterWith();
    await r.processor.process(r.challenge({ amount: '100001' }), PROVIDER);
    expect(r.paid()).toBe(0);
  });

  test('signs once: a repeated request is refused', async () => {
    const r = await requesterWith();
    await r.processor.process(r.challenge(), PROVIDER);
    await r.processor.process(r.challenge(), PROVIDER);
    expect(r.paid()).toBe(1);
  });
});

describe('requester: inference-response', () => {
  test('reports the transport-authenticated sender, so the API can hold it to the selected provider', async () => {
    const h = harness();
    const seen: any[] = [];
    h.events.on('inference-response-req-1', (e) => seen.push(e));
    await h.processor.process(message('inference-response', 'req-1', { to: 'peer-self', payload: { completion: { forged: true } } }), STRANGER);
    expect(seen.length).toBe(1);
    expect(seen[0].from).toBe(STRANGER);
  });
});

describe('RequestLedger', () => {
  test('knows only the provider it was told, by peer id', () => {
    const ledger = new RequestLedger();
    ledger.select('a', { peerId: PROVIDER, payTo: WALLET }, 60_000);
    expect(ledger.isSelectedProvider('a', PROVIDER)).toBe(true);
    expect(ledger.isSelectedProvider('a', STRANGER)).toBe(false);
    expect(ledger.isSelectedProvider('b', PROVIDER)).toBe(false);
  });

  test('allows one payment claim, and gives it back on failure', () => {
    const ledger = new RequestLedger();
    ledger.select('a', { peerId: PROVIDER, payTo: WALLET }, 60_000);
    expect(ledger.claimPayment('a')).toBe(true);
    expect(ledger.claimPayment('a')).toBe(false);
    ledger.unclaimPayment('a');
    expect(ledger.claimPayment('a')).toBe(true);
  });

  test('forgets a released or expired request', async () => {
    const ledger = new RequestLedger();
    ledger.select('a', { peerId: PROVIDER, payTo: WALLET }, 60_000);
    ledger.release('a');
    expect(ledger.providerFor('a')).toBeUndefined();
    ledger.select('b', { peerId: PROVIDER, payTo: WALLET }, 5);
    await new Promise((r) => setTimeout(r, 15));
    expect(ledger.providerFor('b')).toBeUndefined();
    expect(ledger.claimPayment('b')).toBe(false);
  });
});

describe('x402 requirements', () => {
  const issued: any = {
    scheme: 'exact', network: 'algorand:net', asset: '31566704', amount: '1500', payTo: WALLET,
    maxTimeoutSeconds: 120, extra: { decimals: 6, tag: 'x402-global-challenge' },
  };

  test('the same deal matches regardless of key order or number/string form', () => {
    const echoed = { payTo: WALLET, amount: 1500, asset: 31566704, scheme: 'exact', network: 'algorand:net', maxTimeoutSeconds: '120', extra: { tag: 'x402-global-challenge', decimals: 6 } };
    expect(requirementsMismatch(issued, echoed as any)).toBeNull();
  });

  test.each(['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds'])('a different %s is a different deal', (field) => {
    expect(requirementsMismatch(issued, { ...issued, [field]: 'other' })).toBe(field);
  });

  test('different extra is a different deal', () => {
    expect(requirementsMismatch(issued, { ...issued, extra: { ...issued.extra, feePayer: WALLET } })).toBe('extra');
  });

  test('a malformed payment group has no transaction id', () => {
    expect(paymentTransactionId({ payload: {} } as any)).toBeNull();
    expect(paymentTransactionId({ payload: { paymentGroup: ['not base64 msgpack'] } } as any)).toBeNull();
    expect(paymentTransactionId(undefined as any)).toBeNull();
  });
});
