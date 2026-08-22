/**
 * Daemon lifecycle against the compiled binary (spec §6.3 item 6):
 * `start` → `status` → `logs -n 5` → `stop`, asserting `daemon.json` is created
 * and removed.
 *
 * This is the test that proves self-daemonization actually works in a compiled
 * executable — `start` re-spawns `process.execPath` with the internal `__daemon`
 * argument, which only behaves correctly when the binary can find its own entry
 * point inside Bun's virtual filesystem.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_BINARY_REASON,
  binary,
  forceStop,
  freePort,
  makeHome,
  removeHome,
  run,
  writeOfflineConfig,
} from './helpers';

const suite = binary ? describe : describe.skip;
if (!binary) console.warn(`skipping daemon.test.ts: ${NO_BINARY_REASON}`);

suite('compiled binary — daemon lifecycle', () => {
  let home: string;
  let port: number;
  let statePath: string;

  beforeAll(async () => {
    home = makeHome('diiisco-daemon-');
    port = await freePort();
    writeOfflineConfig(home, port);
    statePath = join(home, 'daemon.json');
  });

  afterEach(() => forceStop(home));
  afterAll(() => removeHome(home));

  test('start → status → logs → stop', async () => {
    expect(existsSync(statePath)).toBe(false);

    // --- start ---------------------------------------------------------------
    const started = run(['start'], { home, timeoutMs: 60_000 });
    expect(started.stderr).toBe('');
    expect(started.code).toBe(0);
    expect(started.stdout).toContain(`http://localhost:${port}`);

    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(typeof state.pid).toBe('number');
    expect(state.endpoint).toBe(`http://localhost:${port}`);
    // §3.2: the owner field is how the desktop app and the CLI avoid fighting
    // over the same daemon.
    expect(state.owner).toBe('cli');
    expect(typeof state.startedAt).toBe('string');

    // The daemon really is serving, not just recorded as running.
    const health = await fetch(`http://localhost:${port}/health`);
    expect(health.status).toBe(200);

    // --- status --------------------------------------------------------------
    const status = run(['status', '--json'], { home });
    expect(status.code).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.configured).toBe(true);
    expect(report.running).toBe(true);
    expect(report.stale).toBe(false);
    expect(report.pid).toBe(state.pid);
    expect(report.health.ok).toBe(true);
    expect(report.algorand.mode).toBe('local');

    // --- logs ----------------------------------------------------------------
    const logs = run(['logs', '-n', '5'], { home });
    expect(logs.code).toBe(0);
    expect(logs.stdout.trim().split('\n').length).toBeLessThanOrEqual(5);
    expect(logs.stdout).toContain('[INFO]');

    // --- stop ----------------------------------------------------------------
    const stopped = run(['stop'], { home, timeoutMs: 30_000 });
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain('Stopped');
    expect(existsSync(statePath)).toBe(false);

    const afterStop = run(['status', '--json'], { home });
    expect(JSON.parse(afterStop.stdout).running).toBe(false);
  }, 120_000);

  test('a second start is a no-op that reports the running daemon', () => {
    run(['start'], { home, timeoutMs: 60_000 });
    const again = run(['start'], { home, timeoutMs: 60_000 });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already running');

    // One daemon, one pid — the second start must not have spawned a rival.
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(again.stdout).toContain(String(state.pid));
  }, 120_000);

  test('stop with no daemon is not an error', () => {
    const result = run(['stop'], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No DIIISCO node is running');
  });

  test('a stale daemon.json is cleaned up rather than blocking start', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      statePath,
      JSON.stringify({
        // A pid that cannot be live: 2^22 is above every default pid_max.
        pid: 4_194_303,
        startedAt: new Date().toISOString(),
        endpoint: `http://localhost:${port}`,
        version: '0.0.0',
        owner: 'cli',
      })
    );

    const status = run(['status', '--json'], { home });
    const report = JSON.parse(status.stdout);
    expect(report.running).toBe(false);
    expect(report.stale).toBe(true);

    const started = run(['start'], { home, timeoutMs: 60_000 });
    expect(started.code).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).pid).not.toBe(4_194_303);
  }, 120_000);
});
