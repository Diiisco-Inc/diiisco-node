/**
 * The relay cut every relayed connection 10 minutes after it opened
 * (`src/libp2p/relayLimits.ts`), and nothing said so
 * (`src/libp2p/connectionLog.ts`).
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RELAY_CONNECTION_MEGABYTES,
  DEFAULT_RELAY_CONNECTION_MINUTES,
  relayLimits,
} from '../src/libp2p/relayLimits';
import { describeClose, isRelayedAddress } from '../src/libp2p/connectionLog';

describe('relayLimits', () => {
  test('defaults are well past the 10 minutes that used to cut every relayed peer', () => {
    const { durationLimitMs, dataLimitBytes } = relayLimits();
    expect(durationLimitMs).toBe(DEFAULT_RELAY_CONNECTION_MINUTES * 60_000);
    expect(durationLimitMs).toBeGreaterThan(10 * 60_000);
    expect(dataLimitBytes).toBe(BigInt(DEFAULT_RELAY_CONNECTION_MEGABYTES) * 1024n * 1024n);
    expect(dataLimitBytes).toBeGreaterThan(25n * 1024n * 1024n);
  });

  test('the configured values are used', () => {
    const { durationLimitMs, dataLimitBytes } = relayLimits({ connectionMinutes: 5, connectionMegabytes: 2 });
    expect(durationLimitMs).toBe(5 * 60_000);
    expect(dataLimitBytes).toBe(2n * 1024n * 1024n);
  });

  test('a value that is not a positive number falls back to the default', () => {
    for (const bad of [0, -1, NaN, Infinity, '30' as any, null as any]) {
      const { durationLimitMs, dataLimitBytes } = relayLimits({ connectionMinutes: bad, connectionMegabytes: bad });
      expect(durationLimitMs).toBe(DEFAULT_RELAY_CONNECTION_MINUTES * 60_000);
      expect(dataLimitBytes).toBe(BigInt(DEFAULT_RELAY_CONNECTION_MEGABYTES) * 1024n * 1024n);
    }
  });

  test('a fractional configured value is rounded to whole milliseconds and bytes', () => {
    const { durationLimitMs, dataLimitBytes } = relayLimits({ connectionMinutes: 0.5, connectionMegabytes: 0.5 });
    expect(durationLimitMs).toBe(30_000);
    expect(dataLimitBytes).toBe(524_288n);
  });
});

/** `remaining` is libp2p's live `limits.seconds`: time left on the relay's limit when read. */
const conn = (addr: string, openedMsAgo: number, now: number, remaining?: number | bigint) => ({
  remotePeer: { toString: () => '12D3KooWRyQYWaCBxeNY3YFz383qEuq8yV2RGK2ReSnMCy1KzJtU' },
  remoteAddr: { toString: () => addr },
  timeline: { open: now - openedMsAgo },
  ...(remaining === undefined ? {} : { limits: { seconds: remaining } }),
});

describe('describeClose', () => {
  const NOW = 1_800_000_000_000;
  const RELAYED = '/dns4/lon.diiisco.com/tcp/4242/p2p/12D3KooWDmZrDRQjvicWxG7rDpFjqNcihgHD42a9WvXocYeNek4a/p2p-circuit';

  test('recognises a relayed address', () => {
    expect(isRelayedAddress(RELAYED)).toBe(true);
    expect(isRelayedAddress('/ip4/10.0.0.2/tcp/4242')).toBe(false);
  });

  test('a relayed connection closed at its duration limit says the relay cut it', () => {
    // A 10 minute limit as js-libp2p reports it: 600000 in total, so 599400 remain after 600 s.
    const d = describeClose(conn(RELAYED, 600_000, NOW, 599_400), NOW);
    expect(d.relayed).toBe(true);
    expect(d.message).toContain('after 600s');
    expect(d.message).toContain('relay limit 600s');
    expect(d.message).toContain('cut by the relay');
  });

  test('a relay that reports its limit in true seconds is read as seconds', () => {
    const d = describeClose(conn(RELAYED, 120_000, NOW, 0n), NOW);
    expect(d.message).toContain('relay limit 120s');
    expect(d.message).toContain('cut by the relay');
  });

  test('a fresh relayed connection shows the real limit, not the raw figure', () => {
    // As seen in the field: closed after 0s with libp2p reporting 600000 remaining.
    const d = describeClose(conn(RELAYED, 0, NOW, 600_000), NOW);
    expect(d.message).toContain('after 0s');
    expect(d.message).toContain('relay limit 600s');
    expect(d.message).not.toContain('600000');
    expect(d.message).not.toContain('cut by the relay');
  });

  test('a relayed connection that closed early is not blamed on the relay', () => {
    const d = describeClose(conn(RELAYED, 16_000, NOW, 599_984), NOW);
    expect(d.relayed).toBe(true);
    expect(d.message).toContain('after 16s');
    expect(d.message).not.toContain('cut by the relay');
  });

  test('a direct connection is not relayed', () => {
    const d = describeClose(conn('/ip4/10.0.0.2/tcp/4242', 90_000, NOW), NOW);
    expect(d.relayed).toBe(false);
    expect(d.message).toContain('after 90s');
  });

  test('a connection with no timeline or limits still describes itself', () => {
    const bare = { remotePeer: { toString: () => 'abc' }, remoteAddr: { toString: () => RELAYED } };
    const d = describeClose(bare as any, NOW);
    expect(d.relayed).toBe(true);
    expect(d.message).not.toContain('NaN');
  });
});
