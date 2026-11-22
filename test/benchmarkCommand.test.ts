/**
 * `diiisco benchmark` (plan 018): the control-channel action a running node
 * answers, and the standalone run against the configured backend when no node
 * is running. Driven against the source (`bun src/cli.ts`) with a stub backend.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateControlToken, requestBenchmark, startControlServer, type ControlServer } from '../src/cli/control';
import { makeHome, removeHome, repoRoot } from './helpers';
import { startStubBackend, words, type StubBackend } from './stubBackend';

describe('the benchmark control action', () => {
  let server: ControlServer | null = null;
  afterEach(() => { server?.close(); server = null; });

  test('carries the model names and the list flag, and returns the results', async () => {
    const token = generateControlToken();
    const calls: { models: string[]; list: boolean; verbose: boolean }[] = [];
    server = await startControlServer({
      token,
      onShutdown: () => {},
      onBenchmark: async (models, list, verbose) => {
        calls.push({ models, list, verbose });
        return { results: [{ model: 'a', ok: true, performance: { updatedAt: 1, tokensPerSecond: { value: 50, samples: 4 } } }] };
      },
    });
    const answer = await requestBenchmark(server.port, token, ['a'], true);
    expect(answer.ok).toBe(true);
    expect(answer.value?.results[0].performance?.tokensPerSecond?.value).toBe(50);
    expect(answer.value?.trace).toBeUndefined();
    expect(calls).toEqual([{ models: ['a'], list: true, verbose: false }]);
  });

  test('--verbose asks the node for its steps and gets them back with the results', async () => {
    const token = generateControlToken();
    server = await startControlServer({
      token,
      onShutdown: () => {},
      onBenchmark: async (_models, _list, verbose) => ({
        results: [{ model: 'a', ok: true }],
        ...(verbose ? { trace: ['📏 a: unloaded for a cold start', '📏 a: run 1/4 (cold): sending (timeout 180 s)'] } : {}),
      }),
    });
    const answer = await requestBenchmark(server.port, token, ['a'], false, true);
    expect(answer.ok).toBe(true);
    expect(answer.value?.trace).toEqual(['📏 a: unloaded for a cold start', '📏 a: run 1/4 (cold): sending (timeout 180 s)']);
  });

  test('a refusal from the node comes back as an error the user can read', async () => {
    const token = generateControlToken();
    server = await startControlServer({
      token, onShutdown: () => {},
      onBenchmark: async () => { throw new Error('performance measurement is off on this node'); },
    });
    const answer = await requestBenchmark(server.port, token, [], false);
    expect(answer).toMatchObject({ ok: false, error: 'performance measurement is off on this node' });
  });

  test('too many or malformed model names are refused before any work', async () => {
    const token = generateControlToken();
    let called = false;
    server = await startControlServer({ token, onShutdown: () => {}, onBenchmark: async () => { called = true; return { results: [] }; } });
    const tooMany = await requestBenchmark(server.port, token, Array.from({ length: 17 }, (_, i) => `m${i}`), false);
    expect(tooMany.ok).toBe(false);
    const empty = await requestBenchmark(server.port, token, [''], false);
    expect(empty.ok).toBe(false);
    expect(called).toBe(false);
  });

  test('a wrong token gets nothing', async () => {
    server = await startControlServer({ token: generateControlToken(), onShutdown: () => {}, onBenchmark: async () => ({ results: [] }) });
    const answer = await requestBenchmark(server.port, 'wrong', [], true);
    expect(answer.ok).toBe(false);
  });
});

function cli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['src/cli.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, DIIISCO_HOME: home, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

describe('diiisco benchmark with no node running', () => {
  let stub: StubBackend;
  let home: string;

  const writeConfig = (extraModels: Record<string, unknown> = {}) => writeFileSync(join(home, 'diiisco.config.json'), JSON.stringify({
    models: { enabled: true, baseURL: 'http://127.0.0.1', port: stub.port, apiKey: '', ...extraModels },
    api: { enabled: true, bearerAuthentication: false, keys: [], port: 18999 },
    libp2pBootstrapServers: [],
    local: { enabled: true, privateTopic: 'benchmark-test/models/1.0.0' },
  }), { mode: 0o600 });

  beforeAll(() => {
    stub = startStubBackend({ chunks: words(20), interChunkDelayMs: 2 });
    home = makeHome('diiisco-bench-cli-');
  });
  afterAll(() => { stub.stop(); removeHome(home); });

  test('measures the served chat models and saves the figures', async () => {
    writeConfig();
    const result = await cli(['benchmark', '--json'], home);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(true);
    expect(body.models[0].model).toBe('stub-model');
    expect(body.models[0].performance.ttftHotMs.samples).toBe(3);
    expect(existsSync(join(home, 'model-benchmarks.json'))).toBe(true);
    expect(stub.requests.length).toBe(4);
  });

  test('--list shows the saved figures without measuring', async () => {
    const before = stub.requests.length;
    const result = await cli(['benchmark', '--list', '--json'], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).models[0].performance.tokensPerSecond.samples).toBeGreaterThan(0);
    expect(stub.requests.length).toBe(before);
  });

  test('the table is readable', async () => {
    const result = await cli(['benchmark', '--list'], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stub-model');
    expect(result.stdout).toContain('tok/s');
  });

  test('a model the backend does not serve fails with exit 1', async () => {
    const result = await cli(['benchmark', 'not-a-model', '--json'], home);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).models[0]).toMatchObject({ model: 'not-a-model', ok: false });
  });

  test('measuring switched off is exit 1 with the reason', async () => {
    writeConfig({ benchmark: { enabled: false } });
    const result = await cli(['benchmark', '--json'], home);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('models.benchmark.enabled');
    writeConfig();
  });

  test('an unconfigured node is exit 2', async () => {
    const empty = makeHome('diiisco-bench-empty-');
    try {
      const result = await cli(['benchmark'], empty);
      expect(result.code).toBe(2);
    } finally {
      removeHome(empty);
    }
  });
});
