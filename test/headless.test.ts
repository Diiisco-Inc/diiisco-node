/**
 * A node that serves only inference (`api.enabled: false`) is a valid node.
 *
 * `diiisco start` used to decide it had started by polling the API's `/health`,
 * which such a node can never answer, so it reported failure for a node that
 * was running fine. Liveness now goes over the loopback control channel.
 *
 * The first suite drives the control channel from source; the second drives the
 * compiled binary end to end.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { generateControlToken, requestStatus, startControlServer, type ControlServer, type ControlState } from '../src/cli/control';
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

/** Send one raw line to the control port and return the first line back. */
function rawRequest(port: number, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        socket.destroy();
        resolve(JSON.parse(buffer.split('\n')[0]));
      }
    });
    socket.on('error', reject);
  });
}

describe('control channel — status', () => {
  const token = generateControlToken();
  const state: ControlState = { ready: false, apiEnabled: false };
  let server: ControlServer;
  let shutdowns = 0;

  beforeAll(async () => {
    server = await startControlServer({ token, state, onShutdown: () => void (shutdowns += 1) });
  });
  afterAll(() => server.close());

  test('reports readiness as it changes, without needing an HTTP server', async () => {
    const booting = await requestStatus(server.port, token);
    expect(booting.ok).toBe(true);
    expect(booting.status?.ready).toBe(false);
    expect(booting.status?.apiEnabled).toBe(false);

    state.ready = true;
    const up = await requestStatus(server.port, token);
    expect(up.status?.ready).toBe(true);
    expect(up.status?.pid).toBe(process.pid);
    expect(typeof up.status?.version).toBe('string');
  });

  test('rejects a wrong token and reveals nothing', async () => {
    const answer = await requestStatus(server.port, 'not-the-token');
    expect(answer.ok).toBe(false);
    expect(answer.status).toBeNull();
    expect(answer.error).toBe('unauthorised');
  });

  test('still refuses unknown actions, and status never shuts the node down', async () => {
    expect(await rawRequest(server.port, { action: 'dump-config', token })).toEqual({ ok: false, error: 'unknown action' });
    await requestStatus(server.port, token);
    expect(shutdowns).toBe(0);
  });
});

const suite = binary ? describe : describe.skip;
if (!binary) console.warn(`skipping headless.test.ts (binary suite): ${NO_BINARY_REASON}`);

suite('compiled binary — API disabled', () => {
  let home: string;
  let port: number;

  beforeAll(async () => {
    home = makeHome('diiisco-headless-');
    port = await freePort();
    writeOfflineConfig(home, port, {
      api: { enabled: false, bearerAuthentication: false, keys: ['diiisco'], port },
    });
  });

  afterEach(() => forceStop(home));
  afterAll(() => removeHome(home));

  test('start succeeds, status reports it running, and nothing listens on the API port', async () => {
    const started = run(['start'], { home, timeoutMs: 60_000 });
    expect(started.stderr).toBe('');
    expect(started.code).toBe(0);
    expect(started.stdout).toContain('API disabled');

    const status = run(['status', '--json'], { home });
    expect(status.code).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.running).toBe(true);
    expect(report.apiEnabled).toBe(false);
    expect(report.health.ok).toBe(true);

    await expect(fetch(`http://localhost:${port}/health`)).rejects.toBeDefined();

    const stopped = run(['stop'], { home, timeoutMs: 30_000 });
    expect(stopped.code).toBe(0);
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  }, 120_000);

  test('launch refuses clearly instead of starting a node it cannot reach', () => {
    const result = run(['launch', 'claude'], { home, timeoutMs: 30_000 });
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('api.enabled');
    // It must not have started anything.
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  });
});
