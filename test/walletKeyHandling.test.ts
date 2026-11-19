/**
 * The wallet's secret is held as a key on `account`, derived once; the mnemonic
 * is not kept on the signing object (review L1), and signatures still verify.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import algosdk from 'algosdk';
import environment from '../src/environment/runtime';

const account = algosdk.generateAccount();
const saved = { local: environment.local, algorand: environment.algorand };

afterAll(() => {
  environment.local = saved.local;
  environment.algorand = saved.algorand;
});

function publicNode() {
  environment.local = { enabled: false };
  environment.algorand = {
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
    network: 'mainnet',
    client: { address: 'http://127.0.0.1', port: 1, token: '' },
    settlement: { methods: ['x402'], maxSpend: 0.1 },
  };
  const algorand = require('../src/utils/algorand').default;
  return new algorand();
}

describe('wallet key handling', () => {
  beforeAll(() => {});

  test('the mnemonic is not a property of the signing object, in either mode', () => {
    const pub = publicNode();
    expect((pub as any).mnemonic).toBeUndefined();
    expect(JSON.stringify(Object.keys(pub))).not.toContain('mnemonic');

    environment.local = { enabled: true, privateTopic: 'wallet-key-test/models/1.0.0' };
    const algorand = require('../src/utils/algorand').default;
    expect((new algorand() as any).mnemonic).toBeUndefined();
  });

  test('the account is the one the mnemonic derives to', () => {
    expect(publicNode().account.addr.toString()).toBe(account.addr.toString());
  });

  test('a signed object verifies, and tampering or a wrong signer does not', async () => {
    const algo = publicNode();
    const msg: any = { role: 'list-models', id: 'x', timestamp: 1, fromWalletAddr: algo.account.addr.toString() };
    msg.signature = await algo.signObject(msg);
    expect(await algo.verifySignature(msg)).toBe(true);
    expect(await algo.verifySignature({ ...msg, id: 'y' })).toBe(false);

    const other = algosdk.generateAccount();
    expect(await algo.verifySignature({ ...msg, fromWalletAddr: other.addr.toString() })).toBe(false);
  });

  test('re-signing an already signed object ignores the old signature', async () => {
    const algo = publicNode();
    const msg: any = { role: 'list-models', id: 'x', timestamp: 1, fromWalletAddr: algo.account.addr.toString() };
    const first = await algo.signObject(msg);
    msg.signature = first;
    expect(await algo.signObject(msg)).toBe(first);
  });
});
