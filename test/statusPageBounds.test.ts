/**
 * The public status pages keep state keyed by peer ids a stranger chooses (review
 * pass 2): none of it may grow without bound.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { configureEnvironment } from '../src/environment/runtime';
import { createApiServer } from '../src/api/server';

const PORT = 20000 + Math.floor(Math.random() * 900);
const events = new EventEmitter();
let server: any;

beforeAll(() => {
  configureEnvironment({
    local: { enabled: true, privateTopic: 'status-bounds-test/models/1.0.0' },
    api: { enabled: true, port: PORT, host: '127.0.0.1', bearerAuthentication: false, keys: [] },
  } as any);
  const node: any = { peerId: { toString: () => 'peer-self' }, getConnections: () => [], getMultiaddrs: () => [] };
  const algo: any = { account: { addr: { toString: () => 'WALLET' } }, signObject: async () => 'sig' };
  ({ server } = createApiServer(node, events, algo, { sendMessage: async () => {} } as any, { enqueue: async () => {} } as any));
});
afterAll(() => { server?.close(); });

describe('status pages', () => {
  test('the registry of known nodes is bounded, keeping the most recently seen', async () => {
    for (let i = 0; i < 6000; i++) events.emit('network-node-received', { peerId: `peer-${i}`, walletAddr: 'W' });
    const body = await (await fetch(`http://127.0.0.1:${PORT}/nodes.json`)).json();
    expect(body.data.length).toBeLessThanOrEqual(5000 + 1); // the cap, plus this node pinned on top
    const ids = body.data.map((d: any) => d.peerId);
    expect(ids).toContain('peer-5999');
    expect(ids).not.toContain('peer-0');
  });
});
