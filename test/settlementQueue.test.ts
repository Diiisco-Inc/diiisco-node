/**
 * Accepted payments are kept until settled (review M3): a failing settlement
 * stays queued, survives a restart, and is dropped once its payment can no
 * longer be submitted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import algosdk from 'algosdk';
import environment from '../src/environment/runtime';
import { SettlementQueue, SETTLEMENT_VALIDITY_MS, type PendingSettlement } from '../src/settlement/settlementQueue';

const entry = (id: string, createdAt = Date.now()): PendingSettlement => ({
  quoteId: id, method: 'x402', expected: { amount: '1500' }, evidence: { payload: 'signed' }, createdAt, attempts: 0,
});

describe('SettlementQueue', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'diiisco-settle-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('entries survive a restart, and the file is private', () => {
    const path = join(dir, 'a', 'pending.json'); // directory is created
    const first = new SettlementQueue(path);
    first.add(entry('q1'));
    first.add(entry('q2'));
    first.recordAttempt('q1');

    const second = new SettlementQueue(path);
    second.load();
    expect(second.list().map((e) => e.quoteId).sort()).toEqual(['q1', 'q2']);
    expect(second.get('q1')!.attempts).toBe(1);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('a removed entry stays removed after a restart', () => {
    const path = join(dir, 'b.json');
    const q = new SettlementQueue(path);
    q.add(entry('q1'));
    q.remove('q1');
    const again = new SettlementQueue(path);
    again.load();
    expect(again.list()).toEqual([]);
  });

  test('an expired entry is dropped, on read and on load', () => {
    const path = join(dir, 'c.json');
    let now = 1_000_000;
    const q = new SettlementQueue(path, () => now);
    q.add(entry('old', now));
    now += SETTLEMENT_VALIDITY_MS + 1;
    expect(q.get('old')).toBeUndefined();
    expect(q.list()).toEqual([]);

    const writer = new SettlementQueue(path, () => now);
    writer.add(entry('stale', now - SETTLEMENT_VALIDITY_MS - 5));
    writer.add(entry('fresh', now));
    const reader = new SettlementQueue(path, () => now);
    reader.load();
    expect(reader.list().map((e) => e.quoteId)).toEqual(['fresh']);
  });

  test('a corrupt or hostile file is ignored, not thrown', () => {
    for (const [i, content] of ['not json', '{"entries": "nope"}', '{"entries":[null, 5, {"quoteId": 1}]}'].entries()) {
      const path = join(dir, `bad-${i}.json`);
      writeFileSync(path, content);
      const q = new SettlementQueue(path);
      expect(() => q.load()).not.toThrow();
      expect(q.list()).toEqual([]);
    }
  });

  test('without a path it is in-memory and writes nothing', () => {
    const q = new SettlementQueue();
    q.add(entry('q1'));
    expect(q.size).toBe(1);
    expect(existsSync(join(dir, 'undefined'))).toBe(false);
  });
});

describe('MessageProcessor settlement', () => {
  const account = algosdk.generateAccount();
  const saved = { local: environment.local, algorand: environment.algorand };
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'diiisco-settle-proc-'));
    environment.local = { enabled: false };
    environment.algorand = {
      mnemonic: algosdk.secretKeyToMnemonic(account.sk),
      network: 'mainnet',
      client: { address: 'http://127.0.0.1', port: 1, token: '' },
      settlement: { methods: ['x402'], maxSpend: 0.1 },
    };
  });
  afterAll(() => {
    environment.local = saved.local;
    environment.algorand = saved.algorand;
    rmSync(dir, { recursive: true, force: true });
  });

  function processorWith(queue: SettlementQueue, settle: () => Promise<{ txid: string; amount: bigint }>) {
    const algo: any = { account, signObject: async () => 's', isValidAddress: () => true, verifySignature: async () => true, nfdVerified: false };
    const models: any = { list: () => [], models: () => [], kindOf: () => 'chat', isAvailable: () => true, ensureAvailable: async () => true, invalidate: () => {} };
    const { MessageProcessor } = require('../src/messaging/messageProcessor');
    const quoteEngineModule = require('../src/utils/quoteEngine');
    const { RequestLedger } = require('../src/messaging/requestLedger');
    const { ModelListCollector } = require('../src/messaging/modelListCollector');
    const processor = new MessageProcessor(
      algo, { getModels: async () => [] }, new quoteEngineModule.default({ emit: () => {} }, algo), models,
      new EventEmitter(), { sendMessage: async () => {} }, 'peer-self', { peerStore: { merge: async () => {} } },
      new RequestLedger(), new ModelListCollector(), queue,
    );
    const stub = Object.create((processor as any).settlement.get('x402'));
    let calls = 0;
    stub.settle = async () => { calls += 1; return settle(); };
    (processor as any).settlement.register(stub);
    (processor as any).settleDelaysMs = [1, 1, 1];
    return { processor, calls: () => calls };
  }

  const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 5));
    return check();
  };

  test('a successful settlement leaves nothing queued', async () => {
    const queue = new SettlementQueue(join(dir, 'ok.json'));
    const { processor, calls } = processorWith(queue, async () => ({ txid: 'tx', amount: 1n }));
    (processor as any).settleInBackground((processor as any).settlement.get('x402'), 'q1', {}, {});
    expect(await until(() => calls() === 1 && queue.size === 0)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'ok.json'), 'utf8')).entries).toEqual([]);
  });

  test('a failing settlement stays queued after its retries, with the attempts counted', async () => {
    const path = join(dir, 'fail.json');
    const queue = new SettlementQueue(path);
    const { processor, calls } = processorWith(queue, async () => { throw new Error('facilitator down'); });
    (processor as any).settleInBackground((processor as any).settlement.get('x402'), 'q1', {}, {});
    expect(await until(() => calls() === 3)).toBe(true);
    await until(() => !(processor as any).settling.has('q1'));
    expect(processor.pendingSettlements()).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).entries[0].attempts).toBe(3);
  });

  test('after a restart the queued payment is resumed and settled', async () => {
    const path = join(dir, 'resume.json');
    const before = new SettlementQueue(path);
    const failing = processorWith(before, async () => { throw new Error('down'); });
    (failing.processor as any).settleInBackground((failing.processor as any).settlement.get('x402'), 'q1', {}, {});
    await until(() => failing.calls() === 3);
    await until(() => !(failing.processor as any).settling.has('q1'));

    const after = new SettlementQueue(path);
    after.load();
    expect(after.size).toBe(1);
    const healthy = processorWith(after, async () => ({ txid: 'tx', amount: 1n }));
    healthy.processor.resumeSettlements();
    expect(await until(() => healthy.calls() === 1 && after.size === 0)).toBe(true);
  });

  test('an unrelated failure inside the retry loop never rejects', async () => {
    const queue = new SettlementQueue();
    const { processor } = processorWith(queue, async () => ({ txid: 't', amount: 1n }));
    queue.add({ quoteId: 'odd', method: 'no-such-method', expected: {}, evidence: {}, createdAt: Date.now(), attempts: 0 });
    await expect((processor as any).runSettlement('odd')).resolves.toBeUndefined();
  });
});
