/**
 * Graceful shutdown via the daemon control channel (`src/cli/control.ts`).
 *
 * The behaviour this suite pins down is the reason the control channel exists:
 * `stop` must run `Application.shutdown()` to completion — API server drained,
 * GossipSub topics unsubscribed, libp2p closed — rather than terminating the
 * process where it stands, which is what a bare `process.kill` does on Windows.
 *
 * Every test drives the **compiled binary** with an isolated `DIIISCO_HOME`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_BINARY_REASON,
  binary,
  forceStop,
  freePort,
  makeHome,
  removeHome,
  run,
  sleep,
  writeOfflineConfig,
} from './helpers';

const suite = binary ? describe : describe.skip;
if (!binary) console.warn(`skipping shutdown.test.ts: ${NO_BINARY_REASON}`);

interface Control {
  port: number;
  token: string;
}

function readState(statePath: string): { pid: number; control?: Control } {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** One line of the control protocol, straight onto the socket. */
function speak(port: number, line: string, host = '127.0.0.1', timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host });
    let out = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('control channel timed out'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => (out += chunk));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

suite('compiled binary — graceful shutdown', () => {
  let home: string;
  let port: number;
  let statePath: string;
  let logPath: string;

  beforeAll(async () => {
    home = makeHome('diiisco-shutdown-');
    port = await freePort();
    writeOfflineConfig(home, port);
    statePath = join(home, 'daemon.json');
    logPath = join(home, 'logs', 'diiisco.log');
  });

  afterEach(() => forceStop(home));
  afterAll(() => removeHome(home));

  test('the daemon publishes a loopback control channel in a 0600 daemon.json', () => {
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);

    const state = readState(statePath);
    expect(state.control).toBeDefined();
    expect(typeof state.control!.port).toBe('number');
    expect(state.control!.port).toBeGreaterThan(0);
    // 32 random bytes, hex.
    expect(state.control!.token).toMatch(/^[0-9a-f]{64}$/);

    // The token is a secret: the file that carries it must not be world- or
    // group-readable.
    if (process.platform !== 'win32') {
      expect(statSync(statePath).mode & 0o077).toBe(0);
    }

    // …and `status --json`, which the desktop app consumes, must not leak it.
    const status = run(['status', '--json'], { home });
    const report = JSON.parse(status.stdout);
    expect(report.controlChannel).toBe(true);
    expect(status.stdout).not.toContain(state.control!.token);
  }, 120_000);

  test('stop runs the full shutdown path rather than killing the process', async () => {
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    const { pid } = readState(statePath);

    const stopped = run(['stop'], { home, timeoutMs: 40_000 });
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain('Stopped');
    // Neither the SIGTERM fallback nor the hard kill was needed.
    expect(stopped.stdout).not.toContain('SIGTERM');
    expect(stopped.stderr).toBe('');
    expect(existsSync(statePath)).toBe(false);
    expect(isAlive(pid)).toBe(false);

    // The evidence that Application.shutdown() actually ran, in order.
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('initiating graceful shutdown');
    expect(log).toContain('API server closed');
    expect(log).toContain('Unsubscribed from topic:');
    expect(log).toContain('LibP2P node stopped');
    expect(log).toContain('Graceful shutdown complete');
  }, 120_000);

  test('the control channel rejects a bad token and is not a kill switch', async () => {
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    const state = readState(statePath);
    const control = state.control!;

    // Wrong token, no token, and a token of the right length but wrong value.
    for (const body of [
      JSON.stringify({ action: 'shutdown', token: 'not-the-token' }),
      JSON.stringify({ action: 'shutdown' }),
      JSON.stringify({ action: 'shutdown', token: 'f'.repeat(64) }),
      'this is not json',
    ]) {
      const answer = await speak(control.port, `${body}\n`);
      expect(answer).not.toContain('"ok":true');
    }

    // The right token but an action the channel does not implement.
    const unknown = await speak(control.port, `${JSON.stringify({ action: 'restart', token: control.token })}\n`);
    expect(unknown).toContain('unknown action');

    // Through all of that the node kept running.
    await sleep(500);
    expect(isAlive(state.pid)).toBe(true);
    expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200);
  }, 120_000);

  test('the control channel is bound to loopback only', async () => {
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    const control = readState(statePath).control!;

    // A server bound to 127.0.0.1 cannot be reached on a routable address, so
    // the token never becomes a remote kill switch even if it leaks.
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);

    if (!external) {
      console.warn('  (no external IPv4 interface — loopback binding checked by lsof/netstat only)');
      return;
    }

    await expect(speak(control.port, '{}\n', external.address, 2000)).rejects.toThrow();
  }, 120_000);

  test('a daemon with no control channel still stops, via the signal fallback', async () => {
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    const state = readState(statePath);

    // Exactly what a daemon started by a pre-control-channel diiisco leaves
    // behind. `stop` must not require the block it did not write.
    delete (state as any).control;
    writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });

    const stopped = run(['stop'], { home, timeoutMs: 40_000 });
    expect(stopped.code).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(isAlive(state.pid)).toBe(false);

    if (process.platform !== 'win32') {
      // POSIX SIGTERM is still a graceful shutdown — nothing regressed.
      expect(stopped.stdout).toContain('SIGTERM');
      expect(readFileSync(logPath, 'utf8')).toContain('Graceful shutdown complete');
    }
  }, 120_000);

  test('a wedged daemon is escalated to a hard kill and reported as one', async () => {
    if (process.platform === 'win32') {
      console.warn('  (SIGSTOP has no Windows equivalent — escalation is checked on POSIX only)');
      return;
    }

    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    const { pid } = readState(statePath);

    // A process that can neither answer the control channel nor act on SIGTERM.
    process.kill(pid, 'SIGSTOP');

    const stopped = run(['stop'], { home, timeoutMs: 90_000 });
    expect(stopped.code).toBe(0);
    // Honest reporting is the requirement: the operator must not be told the
    // node stopped cleanly when it was killed.
    expect(stopped.stderr).toContain('force-killed');
    expect(stopped.stdout).toContain('control channel:');
    expect(stopped.stdout).toContain('Shutdown did not complete');
    expect(existsSync(statePath)).toBe(false);

    await sleep(500);
    expect(isAlive(pid)).toBe(false);
  }, 150_000);
});
