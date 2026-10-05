/**
 * Input from other peers, and operator-facing hardening (release/1.0.9 review,
 * plan 011).
 *
 * Unhandled rejections exit the process, so any message that makes a handler
 * or a timer throw is a way for one peer to take down every node that hears
 * it. These assert the shape checks that keep stranger-supplied bytes from
 * ever reaching code that assumes a shape — and the small helpers behind the
 * loopback API default.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { encode } from 'msgpackr';
import environment from '../src/environment/runtime';
import { parseWireMessage } from '../src/messaging/wire';
import { ExpiringMap } from '../src/utils/expiringMap';
import { isLoopbackHost, isWildcardHost, hostnameOfHostHeader, hostnameOfUrl } from '../src/utils/hosts';
import { environmentWarnings, validateEnvironment } from '../src/environment/validate';
import { withDefaults } from '../src/environment/defaults';

const WALLET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('parseWireMessage', () => {
  const valid = { role: 'quote-request', fromWalletAddr: WALLET, signature: 'sig', id: 'x', payload: {} };

  test('accepts a well-formed message', () => {
    expect(parseWireMessage(encode(valid))?.role).toBe('quote-request');
  });

  test.each([
    ['garbage bytes', new Uint8Array([0xc1, 0xff, 0x00, 0x13])],
    ['empty input', new Uint8Array()],
    ['a bare number (`in` would throw a TypeError)', encode(42)],
    ['a string', encode('hello')],
    ['null', encode(null)],
    ['an array', encode([1, 2, 3])],
    ['no signature', encode({ ...valid, signature: undefined })],
    ['a non-string signature (Buffer.from would throw)', encode({ ...valid, signature: 12345 })],
    ['a non-string role', encode({ ...valid, role: { x: 1 } })],
    ['a non-string wallet address', encode({ ...valid, fromWalletAddr: ['a'] })],
    ['a non-string `to`', encode({ ...valid, to: 7 })],
  ])('drops %s', (_name, bytes) => {
    expect(parseWireMessage(bytes as Uint8Array)).toBeNull();
  });
});

describe('quote and model-list shapes', () => {
  const saved = { local: environment.local, waitTime: environment.quoteEngine.waitTime };
  beforeAll(() => {
    environment.local = { enabled: true, privateTopic: 'untrusted-input-test/1.0.0' }; // no on-chain enrichment
    environment.quoteEngine.waitTime = 20;
  });
  afterAll(() => {
    environment.local = saved.local;
    environment.quoteEngine.waitTime = saved.waitTime;
  });

  const quote = (id: string, over: Record<string, unknown> = {}): any => ({
    role: 'quote-response', id, to: 'me', timestamp: Date.now(), fromWalletAddr: WALLET,
    payload: {
      model: 'm',
      quote: { model: 'm', addr: WALLET, tokenCount: 1, pricePerInputToken1M: 1, pricePerOutputToken1M: 1, requestTimestamp: Date.now(), ...over },
    },
  });
  const engine = () => new (require('../src/utils/quoteEngine').default)(new EventEmitter(), {});

  test('a malformed quote-response is dropped on arrival, not found by a timer later', async () => {
    const q = engine();
    const bad: any[] = [
      { id: 'a', payload: {} },
      { ...quote('b'), payload: { quote: null } },
      quote('c', { pricePerInputToken1M: 'free' }),
      quote('d', { pricePerOutputToken1M: -1 }),
      quote('e', { addr: 5 }),
      quote('__proto__'),
      42,
      null,
    ];
    for (const msg of bad) await q.addQuote({ msg, from: 'peer' });
    expect(Object.keys(q.quoteQueue)).toEqual([]);
  });

  test('a good quote still wins its auction, after a bad one arrived first', async () => {
    const events = new EventEmitter();
    const q = new (require('../src/utils/quoteEngine').default)(events, {});
    const selected = new Promise<any>((resolve) => events.once('quote-selected-ok', resolve));
    await q.addQuote({ msg: { ...quote('ok'), payload: { quote: 'nonsense' } }, from: 'bad-peer' });
    await q.addQuote({ msg: quote('ok'), from: 'good-peer' });
    expect((await selected).from).toBe('good-peer');
    expect(Object.keys(q.quoteQueue)).toEqual([]);
  });

  test('a list-models-response that is not a list of models cannot make the compile timer throw', async () => {
    const { OpenAIInferenceModel } = require('../src/utils/models');
    const events = new EventEmitter();
    const model = new OpenAIInferenceModel('http://127.0.0.1:1/v1', events);
    const compiled = new Promise<any[]>((resolve) => events.once('model-list-compiled', resolve));

    await model.addModel([{ id: 'a' }, null, 5, 'x', { notId: 1 }, { id: 'a' }, { id: 'b' }]);
    expect((await compiled).map((m: any) => m.id)).toEqual(['a', 'b']);

    const second = new Promise<any[]>((resolve) => events.once('model-list-compiled', resolve));
    await model.addModel('garbage' as any);
    expect(await second).toEqual([]);
  });
});

describe('ExpiringMap', () => {
  test('entries expire, and take() is single-use', async () => {
    const map = new ExpiringMap<string, number>();
    map.set('a', 1, 60_000);
    map.set('b', 2, 5);
    expect(map.take('a')).toBe(1);
    expect(map.take('a')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 15));
    expect(map.get('b')).toBeUndefined();
    expect(map.size).toBe(0);
  });
});

describe('API host helpers', () => {
  test.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  test.each(['0.0.0.0', '192.168.1.5', 'evil.example.com', '127.0.0.1.evil.com', '::'])('%s is not loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
  test('wildcards', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
  });
  test('Host header and URL parsing', () => {
    expect(hostnameOfHostHeader('localhost:8080')).toBe('localhost');
    expect(hostnameOfHostHeader('[::1]:8080')).toBe('[::1]');
    expect(hostnameOfHostHeader('Evil.Example.com')).toBe('evil.example.com');
    expect(hostnameOfHostHeader(undefined)).toBeUndefined();
    expect(hostnameOfHostHeader('bad host!')).toBeUndefined();
    expect(hostnameOfUrl('https://node.example.com:4242/x')).toBe('node.example.com');
    expect(hostnameOfUrl('node.example.com')).toBe('node.example.com');
  });
});

describe('API defaults and warnings', () => {
  const publicNode = (api: Record<string, unknown> = {}) => withDefaults({
    algorand: {
      mnemonic: Array(25).fill('abandon').join(' '),
      client: { address: 'http://x', port: 443, token: '' },
      settlement: { maxSpend: 0.1 },
    },
    api,
  } as any);

  test('the API binds loopback unless told otherwise', () => {
    expect(publicNode().api.host).toBe('127.0.0.1');
  });

  test('an unauthenticated public-mode API is warned about, more strongly when exposed', () => {
    const local = environmentWarnings(publicNode());
    expect(local.length).toBe(1);
    expect(local[0]).toContain('only listens on this machine');

    const exposed = environmentWarnings(publicNode({ host: '0.0.0.0' }));
    expect(exposed[0]).toContain('anyone who can reach this machine');
  });

  test('no warning with a key, or in local mode (no wallet to protect)', () => {
    expect(environmentWarnings(publicNode({ bearerAuthentication: true }))).toEqual([]);
    expect(environmentWarnings(withDefaults({ local: { enabled: true, privateTopic: 't' } } as any))).toEqual([]);
  });

  test('a bad api.host, corsOrigins or allowedHosts is a config error', () => {
    const errors = validateEnvironment(publicNode({ host: '', corsOrigins: [1], allowedHosts: 'x' }));
    expect(errors.some((e) => e.includes('api.host'))).toBe(true);
    expect(errors.some((e) => e.includes('api.corsOrigins'))).toBe(true);
    expect(errors.some((e) => e.includes('api.allowedHosts'))).toBe(true);
  });
});
