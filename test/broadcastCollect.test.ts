/**
 * Broadcast-and-collect (review L4): every exit path releases its listeners and
 * timers, including a client that disconnects mid-request, and a request id is
 * random.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { collect } from '../src/api/collect';
import { newRequestId } from '../src/utils/requestId';
import { configureEnvironment } from '../src/environment/runtime';
import { createApiServer } from '../src/api/server';
import { ModelListCollector } from '../src/messaging/modelListCollector';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emitterSubscribe(events: EventEmitter, name: string) {
  return (push: (x: any) => void) => {
    events.on(name, push);
    return () => events.off(name, push);
  };
}

describe('collect()', () => {
  test('gathers replies for the window, then releases its listener', async () => {
    const events = new EventEmitter();
    const pending = collect<number>({
      windowMs: 30,
      subscribe: emitterSubscribe(events, 'x'),
      send: async () => { events.emit('x', 1); events.emit('x', 2); },
    });
    const { items, aborted } = await pending;
    expect(items).toEqual([1, 2]);
    expect(aborted).toBe(false);
    expect(events.listenerCount('x')).toBe(0);
  });

  test('stops early once `until` replies are in', async () => {
    const events = new EventEmitter();
    const started = Date.now();
    const { items } = await collect<number>({
      windowMs: 10_000, until: 1,
      subscribe: emitterSubscribe(events, 'x'),
      send: async () => { setTimeout(() => events.emit('x', 7), 5); },
    });
    expect(items).toEqual([7]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(events.listenerCount('x')).toBe(0);
  });

  test('a reply that arrives before send() resolves still counts', async () => {
    const events = new EventEmitter();
    const { items } = await collect<number>({
      windowMs: 20, until: 1,
      subscribe: emitterSubscribe(events, 'x'),
      send: async () => { events.emit('x', 9); await sleep(20); },
    });
    expect(items).toEqual([9]);
  });

  test('a failed send rejects and releases the listener', async () => {
    const events = new EventEmitter();
    await expect(collect({
      windowMs: 1000,
      subscribe: emitterSubscribe(events, 'x'),
      send: async () => { throw new Error('no peers'); },
    })).rejects.toThrow('no peers');
    expect(events.listenerCount('x')).toBe(0);
  });

  test('an abort ends it at once, releases the listener and reports aborted', async () => {
    const events = new EventEmitter();
    const controller = new AbortController();
    const pending = collect({
      windowMs: 60_000, signal: controller.signal,
      subscribe: emitterSubscribe(events, 'x'),
      send: async () => {},
    });
    await sleep(5);
    controller.abort();
    expect((await pending).aborted).toBe(true);
    expect(events.listenerCount('x')).toBe(0);
  });

  test('an already-aborted signal never subscribes', async () => {
    const controller = new AbortController();
    controller.abort();
    let subscribed = false;
    const result = await collect({ windowMs: 10, signal: controller.signal, subscribe: () => { subscribed = true; return () => {}; }, send: async () => {} });
    expect(result.aborted).toBe(true);
    expect(subscribed).toBe(false);
  });

  test('it removes only its own listener from a shared event', async () => {
    const events = new EventEmitter();
    let other = 0;
    events.on('x', () => { other += 1; });
    await collect({ windowMs: 5, subscribe: emitterSubscribe(events, 'x'), send: async () => {} });
    events.emit('x');
    expect(other).toBe(1);
  });

  test('replies after the window are ignored', async () => {
    const events = new EventEmitter();
    const push: { fn?: (x: number) => void } = {};
    const { items } = await collect<number>({
      windowMs: 5,
      subscribe: (p) => { push.fn = p; return () => {}; },
      send: async () => {},
    });
    push.fn!(5);
    expect(items).toEqual([]);
    expect(events.listenerCount('x')).toBe(0);
  });
});

describe('newRequestId()', () => {
  test('is 56 hex characters and never repeats', () => {
    const ids = new Set(Array.from({ length: 1000 }, newRequestId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{56}$/);
  });
});

describe('API endpoints leave nothing behind', () => {
  const PORT = 19000 + Math.floor(Math.random() * 900);
  const events = new EventEmitter();
  const lists = new ModelListCollector();
  let server: any;
  let sendFails = false;
  let baseline = 0; // the status pages keep one permanent listener of their own
  const sent: any[] = [];

  beforeAll(() => {
    configureEnvironment({
      local: { enabled: true, privateTopic: 'collect-test/models/1.0.0' },
      api: { enabled: true, port: PORT, host: '127.0.0.1', bearerAuthentication: false, keys: [], networkWaitTime: 40 },
      quoteEngine: { waitTime: 40 },
    } as any);
    const node: any = { peerId: { toString: () => 'peer-self' }, getConnections: () => [] };
    const algo: any = { account: { addr: { toString: () => 'WALLET' } }, signObject: async () => 'sig' };
    const meshQueue: any = {
      enqueue: async (m: any) => { if (sendFails) throw new Error('mesh not ready'); sent.push(m); },
    };
    ({ server } = createApiServer(node, events, algo, {} as any, meshQueue, undefined, undefined, undefined, lists));
    baseline = events.listenerCount('network-node-received');
  });
  afterAll(() => { server?.close(); });

  const get = (path: string, signal?: AbortSignal) => fetch(`http://127.0.0.1:${PORT}${path}`, { signal });

  test('/network answers with what arrived and removes its listener', async () => {
    const pending = get('/network');
    await sleep(10);
    events.emit('network-node-received', { peerId: 'p1' });
    const body = await (await pending).json();
    expect(body.data).toEqual([{ peerId: 'p1' }]);
    expect(events.listenerCount('network-node-received')).toBe(baseline);
  });

  test('/network with a client that disconnects mid-wait leaves no listener', async () => {
    const controller = new AbortController();
    const request = get('/network', controller.signal).catch(() => 'aborted');
    await sleep(15);
    expect(events.listenerCount('network-node-received')).toBe(baseline + 1);
    controller.abort();
    await request;
    await sleep(20);
    expect(events.listenerCount('network-node-received')).toBe(baseline);
  });

  test('/network when the mesh cannot take the request is a 500 with no listener left', async () => {
    sendFails = true;
    const res = await get('/network');
    sendFails = false;
    expect(res.status).toBe(500);
    expect(events.listenerCount('network-node-received')).toBe(baseline);
  });

  test('/v1/models falls back to this node\'s own models, and closes its collection', async () => {
    const res = await get('/v1/models');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
    const id = sent.filter((m) => m.role === 'list-models').at(-1).id;
    expect(lists.isOpen(id)).toBe(false);
  });

  test('/v1/models uses the answers to its own request, and nobody else\'s', async () => {
    const pending = get('/v1/models?type=all');
    await sleep(10);
    const id = sent.filter((m) => m.role === 'list-models').at(-1).id;
    expect(lists.add('some-other-request', 'peer-b', [{ id: 'stranger-model' }])).toBe(false);
    expect(lists.add(id, 'peer-a', [{ id: 'real-model' }])).toBe(true);
    const body = await (await pending).json();
    expect(body.data.map((m: any) => m.id)).toEqual(['real-model']);
  });

  test('/v1/models with a client that disconnects closes its collection', async () => {
    const controller = new AbortController();
    const request = get('/v1/models', controller.signal).catch(() => 'aborted');
    await sleep(15);
    const id = sent.filter((m) => m.role === 'list-models').at(-1).id;
    expect(lists.isOpen(id)).toBe(true);
    controller.abort();
    await request;
    await sleep(20);
    expect(lists.isOpen(id)).toBe(false);
  });
});
