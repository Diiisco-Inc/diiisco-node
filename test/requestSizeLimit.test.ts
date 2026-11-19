/**
 * A request too big for the one direct message that carries it to a provider is
 * refused up front with a 413 (review M5), not dropped silently by a provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import environment from '../src/environment/runtime';
import { configureEnvironment } from '../src/environment/runtime';
import { createApiServer } from '../src/api/server';
import { RequestTooLargeError, statusForInferenceError, messageForInferenceError } from '../src/api/inferenceErrors';
import { DEFAULT_DIRECT_MESSAGING_CONFIG } from '../src/utils/defaults';

const PORT = 18000 + Math.floor(Math.random() * 1000);
let server: any;
const enqueued: any[] = [];

beforeAll(() => {
  configureEnvironment({
    local: { enabled: true, privateTopic: 'size-limit-test/models/1.0.0' },
    api: { enabled: true, port: PORT, host: '127.0.0.1', bearerAuthentication: false, keys: [] },
  } as any);
  const node: any = { peerId: { toString: () => 'peer-self' }, getConnections: () => [] };
  const algo: any = { account: { addr: { toString: () => 'WALLET' } }, signObject: async () => 'sig' };
  const meshQueue: any = { enqueue: async (m: any) => { enqueued.push(m); } };
  ({ server } = createApiServer(node, new EventEmitter(), algo, {} as any, meshQueue, undefined, undefined));
});
afterAll(() => { server?.close(); });

const post = (body: unknown) =>
  fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

describe('request size limit', () => {
  test('a request over the direct message limit gets a 413 and no auction is started', async () => {
    const limit = DEFAULT_DIRECT_MESSAGING_CONFIG.maxMessageSize;
    const res = await post({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(limit + 1000) }] });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('bytes per request');
    expect(enqueued).toEqual([]);
  });

  test('a normal request is not refused for size (it proceeds to the auction)', async () => {
    environment.quoteEngine.auctionTimeout = 50;
    const res = await post({ model: 'm', messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(503); // nobody quoted — but not 413
    expect(enqueued.length).toBeGreaterThan(0);
  });

  test('the error maps to 413 with its own message', () => {
    const err = new RequestTooLargeError(20, 10);
    expect(statusForInferenceError(err)).toBe(413);
    expect(messageForInferenceError(err)).toContain('at most 10 bytes');
  });
});
