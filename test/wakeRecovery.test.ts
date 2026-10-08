/**
 * Waking from sleep (`src/libp2p/reconnection.ts`).
 *
 * The machine's clock jumps, the network is usually not up yet, and a single
 * bootstrap dial used to fail and leave the node offline until the next
 * health check. Everything here runs against a stub node with an instant
 * `sleep`, so the backoff is exercised without waiting for it.
 */
import { describe, expect, test } from 'bun:test';
import { recoverAfterWake, startSleepDetector } from '../src/libp2p/reconnection';

const instant = async () => {};

/** A node whose bootstrap dial fails `failures` times, then connects. */
function stubNode(failures: number, options: { subscribersAfterResubscribe?: boolean; alwaysSubscribed?: boolean } = {}) {
  let dials = 0;
  let connected = false;
  let resubscribed = 0;
  const node = {
    dial: async () => {
      dials += 1;
      if (dials <= failures) throw new Error('network unreachable');
      connected = true;
    },
    getConnections: () => (connected ? [{ remotePeer: 'bootstrap' }] : []),
    services: {
      pubsub: {
        getSubscribers: () => (options.alwaysSubscribed || (options.subscribersAfterResubscribe && resubscribed > 0) ? ['peer'] : []),
        unsubscribe: () => {},
        subscribe: () => { resubscribed += 1; },
      },
    },
  };
  return { node, get dials() { return dials; }, get resubscribed() { return resubscribed; } };
}

const deps = (node: any, bootstrapAddresses: string[] = ['/dns4/lon.diiisco.com/tcp/4242/p2p/x']) =>
  ({ node, bootstrapAddresses }) as any;

const fast = { settleMs: 0, sleep: instant };

describe('recoverAfterWake', () => {
  test('retries until the network is back, instead of giving up after one dial', async () => {
    const stub = stubNode(2); // two failed dials: the radio is still coming up

    const result = await recoverAfterWake(deps(stub.node), { ...fast, delaysMs: [0, 1, 1, 1] });

    expect(result).toEqual({ connected: true, meshReady: true, attempts: 3 });
    expect(stub.dials).toBe(3);
  });

  test('stops retrying as soon as it is connected', async () => {
    const stub = stubNode(0);

    const result = await recoverAfterWake(deps(stub.node), { ...fast, delaysMs: [0, 1, 1, 1, 1] });

    expect(result.attempts).toBe(1);
    expect(stub.dials).toBe(1);
  });

  test('reports failure, not a hang, when the network never returns', async () => {
    const stub = stubNode(Infinity);

    const result = await recoverAfterWake(deps(stub.node), { ...fast, delaysMs: [0, 1, 1] });

    expect(result).toEqual({ connected: false, meshReady: false, attempts: 3 });
  });

  test('abandons recovery when the node is shutting down', async () => {
    const stub = stubNode(Infinity);
    let calls = 0;

    const result = await recoverAfterWake(deps(stub.node), { ...fast, delaysMs: [0, 1, 1, 1], isShuttingDown: () => ++calls > 1 });

    expect(result.connected).toBe(false);
    expect(stub.dials).toBe(1);
  });

  test('a private network has no bootstrap servers and nothing to dial', async () => {
    const stub = stubNode(0);

    const result = await recoverAfterWake(deps(stub.node, []), { ...fast, delaysMs: [0, 1] });

    expect(result).toEqual({ connected: true, meshReady: true, attempts: 0 });
    expect(stub.dials).toBe(0);
  });

  test('waits for mesh subscribers once connected', async () => {
    const stub = stubNode(0, { alwaysSubscribed: true });

    const result = await recoverAfterWake(deps(stub.node), { ...fast, delaysMs: [0], meshTopic: 'mesh', meshWaitMs: 3000 });

    expect(result.meshReady).toBe(true);
    expect(stub.resubscribed).toBe(0);
  });

  test('re-announces its subscription when the mesh stays empty, and recovers', async () => {
    const stub = stubNode(0, { subscribersAfterResubscribe: true });

    const result = await recoverAfterWake(deps(stub.node), { ...fast, delaysMs: [0], meshTopic: 'mesh', meshWaitMs: 3000 });

    expect(stub.resubscribed).toBe(1);
    expect(result).toEqual({ connected: true, meshReady: true, attempts: 1 });
  });

  test('connected but meshless is reported as exactly that', async () => {
    const stub = stubNode(0); // never any subscribers

    const result = await recoverAfterWake(deps(stub.node), { ...fast, delaysMs: [0], meshTopic: 'mesh', meshWaitMs: 2000 });

    expect(result).toEqual({ connected: true, meshReady: false, attempts: 1 });
    expect(stub.resubscribed).toBe(1);
  });
});

describe('startSleepDetector', () => {
  test('fires once, with the gap, when the clock jumps between samples', async () => {
    let clock = 1_000_000;
    let ticks = 0;
    const gaps: number[] = [];
    // Each sample advances 5ms of "wall time", except the third, which jumps a minute.
    const now = () => (clock += ++ticks === 3 ? 60_000 : 5);

    const stop = startSleepDetector((gap) => gaps.push(gap), { pollMs: 5, thresholdMs: 10_000, now });
    await Bun.sleep(80);
    stop();

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThan(50_000);
  });

  test('stays quiet when nothing is suspended, and stop() really stops it', async () => {
    let clock = 0;
    let woke = 0;
    const stop = startSleepDetector(() => woke++, { pollMs: 5, thresholdMs: 10_000, now: () => (clock += 5) });
    await Bun.sleep(40);
    stop();
    const before = clock;
    await Bun.sleep(40);

    expect(woke).toBe(0);
    expect(clock).toBe(before); // the timer is gone
  });
});
