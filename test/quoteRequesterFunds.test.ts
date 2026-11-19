/**
 * A provider quotes only for a requester that can pay (review M2): opted in to
 * USDC, holding at least the cost of the input, and stating a budget.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import algosdk from 'algosdk';
import environment from '../src/environment/runtime';

const account = algosdk.generateAccount();
const WALLET = account.addr.toString();
const RATE = 100; // USDC per 1M tokens; 100 input tokens cost 10 000 µUSDC

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

function harness(lookup: (addr: string, asset: number) => { optedIn: boolean; balance: bigint }) {
  const sent: any[] = [];
  const asked: number[] = [];
  const algo = {
    account,
    signObject: async () => 'signature',
    isValidAddress: () => true,
    verifySignature: async () => true,
    nfdVerified: false,
    checkIfOptedInToAsset: async (addr: string, asset: number) => { asked.push(asset); return lookup(addr, asset); },
  };
  const models: any = {
    list: () => ['gemma3'], models: () => [], kindOf: () => 'chat', isChat: () => true,
    isAvailable: () => true, ensureAvailable: async () => true, refresh: async () => [],
    isHealthy: () => true, invalidate: () => {}, start: () => {}, stop: () => {},
  };
  const { MessageProcessor } = require('../src/messaging/messageProcessor');
  const quoteEngineModule = require('../src/utils/quoteEngine');
  const processor = new MessageProcessor(
    algo, { getModels: async () => [] }, new quoteEngineModule.default({ emit: () => {} }, algo), models,
    new EventEmitter(), { sendMessage: async (m: any) => { sent.push(m); } }, 'peer-self',
    { peerStore: { merge: async () => {} } },
  );
  return { processor, sent, asked };
}

const request = (payload: Record<string, unknown> = {}): any => ({
  role: 'quote-request', id: 'r1', from: 'peer-requester', timestamp: Date.now(), fromWalletAddr: WALLET, signature: 's',
  payload: { model: 'gemma3', inputTokenCount: 100, max_tokens: 256, maxSpend: 0.05, ...payload },
});

describe('quote request: can the requester pay?', () => {
  test('opted in to USDC with enough balance is quoted, and USDC (not DSCO) is what was checked', async () => {
    const { processor, sent, asked } = harness(() => ({ optedIn: true, balance: 1_000_000n }));
    await processor.process(request(), 'peer-requester');
    expect(sent.map((m) => m.role)).toEqual(['quote-response']);
    const { diiiscoAssets } = require('../src/utils/diiiscoAssets');
    expect(asked).toEqual([diiiscoAssets.usdc]);
  });

  test('opted in but a zero balance is not quoted', async () => {
    const { processor, sent } = harness(() => ({ optedIn: true, balance: 0n }));
    await processor.process(request(), 'peer-requester');
    expect(sent).toEqual([]);
  });

  test('a balance below the cost of the input is not quoted; exactly enough is', async () => {
    const low = harness(() => ({ optedIn: true, balance: 9_999n }));
    await low.processor.process(request(), 'peer-requester');
    expect(low.sent).toEqual([]);

    const exact = harness(() => ({ optedIn: true, balance: 10_000n }));
    await exact.processor.process(request(), 'peer-requester');
    expect(exact.sent.length).toBe(1);
  });

  test('not opted in to USDC is not quoted', async () => {
    const { processor, sent } = harness(() => ({ optedIn: false, balance: 0n }));
    await processor.process(request(), 'peer-requester');
    expect(sent).toEqual([]);
  });

  test('a request with no maxSpend is refused before any lookup', async () => {
    const { processor, sent, asked } = harness(() => ({ optedIn: true, balance: 1_000_000n }));
    await processor.process(request({ maxSpend: undefined }), 'peer-requester');
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
  });
});
