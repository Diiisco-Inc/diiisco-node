/**
 * `MessageRouter` delivery rules: prompts, payments and completions are private
 * and must never be published on the GossipSub topic, even when a direct send
 * fails. Non-private roles (a node's profile) may still fall back.
 */
import { describe, expect, test } from 'bun:test';
import { MessageRouter, PRIVATE_ROLES } from '../src/messaging/messageRouter';

function makeRouter(directResult: boolean | 'throw' = false, withHandler = true) {
  const published: any[] = [];
  const node = {
    services: { pubsub: { publish: async (topic: string, data: Uint8Array) => { published.push({ topic, data }); } } },
  };
  const direct: any[] = [];
  const handler = {
    sendDirect: async (peer: string, msg: any) => {
      direct.push({ peer, msg });
      if (directResult === 'throw') throw new Error('boom');
      return directResult;
    },
  };
  const router = new MessageRouter(node, withHandler ? (handler as any) : null);
  return { router, published, direct };
}

const msg = (role: string): any => ({ role, fromWalletAddr: 'W', signature: 's', to: 'peer-b', payload: { secret: 'prompt' } });

describe('MessageRouter private roles', () => {
  for (const role of PRIVATE_ROLES) {
    test(`${role}: a failed direct send throws and nothing is published`, async () => {
      const { router, published } = makeRouter(false);
      await expect(router.sendMessage(msg(role), 'peer-b')).rejects.toThrow(/not falling back/);
      expect(published).toHaveLength(0);
    });

    test(`${role}: a direct send that throws publishes nothing`, async () => {
      const { router, published } = makeRouter('throw');
      await expect(router.sendMessage(msg(role), 'peer-b')).rejects.toThrow();
      expect(published).toHaveLength(0);
    });

    test(`${role}: no target peer is refused, not broadcast`, async () => {
      const { router, published, direct } = makeRouter(true);
      await expect(router.sendMessage(msg(role))).rejects.toThrow(/never broadcast/);
      expect(published).toHaveLength(0);
      expect(direct).toHaveLength(0);
    });

    test(`${role}: with no direct handler it is refused, not broadcast`, async () => {
      const { router, published } = makeRouter(true, false);
      await expect(router.sendMessage(msg(role), 'peer-b')).rejects.toThrow();
      expect(published).toHaveLength(0);
    });

    test(`${role}: a successful direct send publishes nothing`, async () => {
      const { router, published, direct } = makeRouter(true);
      await router.sendMessage(msg(role), 'peer-b');
      expect(direct).toHaveLength(1);
      expect(published).toHaveLength(0);
    });
  }
});

describe('MessageRouter non-private roles', () => {
  test('node-profile-response still falls back to GossipSub when direct fails', async () => {
    const { router, published } = makeRouter(false);
    await router.sendMessage(msg('node-profile-response'), 'peer-b');
    expect(published).toHaveLength(1);
  });

  test('discovery broadcasts go straight to GossipSub', async () => {
    const { router, published, direct } = makeRouter(true);
    await router.sendMessage({ role: 'quote-request', fromWalletAddr: 'W', signature: 's' } as any);
    expect(direct).toHaveLength(0);
    expect(published).toHaveLength(1);
  });

  test('the private role list is exactly the five content-bearing roles', () => {
    expect([...PRIVATE_ROLES].sort()).toEqual(
      ['contract-created', 'contract-signed', 'inference-failed', 'inference-response', 'quote-accepted']
    );
  });
});
