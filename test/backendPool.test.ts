/**
 * Several inference backends behind one node (plan 019): models from every
 * backend are offered, each request goes to the backend that serves its model
 * (the first listed, for a model on more than one), one backend down removes
 * only its models, and the config either names one backend or lists several.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { InferenceBackends, backendsProblems, resolveBackends, type BackendEndpoint } from '../src/utils/backendPool';
import { ModelAvailabilityMonitor } from '../src/utils/modelAvailability';
import { validateEnvironment } from '../src/environment/validate';
import { withDefaults } from '../src/environment/defaults';
import { ConfigError, mergeConfig, toJsonConfig } from '../src/cli/config';
import { startStubBackend, words, type StubBackend } from './stubBackend';

const stubs: StubBackend[] = [];
afterEach(() => { while (stubs.length) stubs.pop()!.stop(); });

function stub(models: string[], extra = {}) {
  const s = startStubBackend({ models, chunks: words(3), ...extra });
  stubs.push(s);
  return s;
}

const endpoint = (s: StubBackend, name: string, apiKey = ''): BackendEndpoint => ({ name, baseURL: 'http://127.0.0.1', port: s.port, apiKey });
const pool = (...endpoints: BackendEndpoint[]) => new InferenceBackends(endpoints, new EventEmitter());
const monitorFor = (p: InferenceBackends) => new ModelAvailabilityMonitor(p, { enabled: true, checkIntervalMs: 0 });
const ask = (p: InferenceBackends, model: string) => p.getResponse(model, [{ role: 'user', content: 'hi' }]);

describe('InferenceBackends', () => {
  test('offers every backend\'s models and sends each request to the backend that serves it', async () => {
    const a = stub(['gemma3']);
    const b = stub(['qwen3']);
    const p = pool(endpoint(a, 'a'), endpoint(b, 'b'));
    const monitor = monitorFor(p);
    await monitor.refresh();

    expect(monitor.list().sort()).toEqual(['gemma3', 'qwen3']);
    await ask(p, 'qwen3');
    await ask(p, 'gemma3');
    expect(a.requests.map((r) => r.body.model)).toEqual(['gemma3']);
    expect(b.requests.map((r) => r.body.model)).toEqual(['qwen3']);
  });

  test('a model on two backends goes to the first listed, and to the next when that one goes down', async () => {
    const a = stub(['gemma3']);
    const b = stub(['gemma3', 'qwen3']);
    const p = pool(endpoint(a, 'a'), endpoint(b, 'b'));
    const monitor = monitorFor(p);
    await monitor.refresh();
    expect(monitor.list().sort()).toEqual(['gemma3', 'qwen3']);
    expect(p.backendFor('gemma3')).toBe('a');

    a.behaviour = { ...a.behaviour, down: true };
    await monitor.refresh();
    expect(monitor.isHealthy()).toBe(true);
    expect(p.backendFor('gemma3')).toBe('b');
    await ask(p, 'gemma3');
    expect(b.requests.length).toBe(1);
  });

  test('one backend down removes only its models; all down makes the node unhealthy', async () => {
    const a = stub(['gemma3']);
    const b = stub(['qwen3']);
    const p = pool(endpoint(a, 'a'), endpoint(b, 'b'));
    const monitor = monitorFor(p);

    b.behaviour = { ...b.behaviour, down: true };
    await monitor.refresh();
    expect(monitor.isHealthy()).toBe(true);
    expect(monitor.list()).toEqual(['gemma3']);
    await expect(ask(p, 'qwen3')).rejects.toThrow('no model backend serves "qwen3"');

    a.behaviour = { ...a.behaviour, down: true };
    await monitor.refresh();
    expect(monitor.isHealthy()).toBe(false);
    expect(monitor.list()).toEqual([]);

    b.behaviour = { ...b.behaviour, down: false };
    await monitor.refresh();
    expect(monitor.list()).toEqual(['qwen3']);
  });

  test('each backend gets its own API key', async () => {
    const a = stub(['gemma3']);
    const b = stub(['qwen3']);
    const p = pool(endpoint(a, 'a', 'key-a'), endpoint(b, 'b'));
    await monitorFor(p).refresh();
    await ask(p, 'gemma3');
    await ask(p, 'qwen3');
    expect(a.requests[0].authorization).toBe('Bearer key-a');
    // No key configured: the SDK's placeholder, never another backend's key.
    expect(b.requests[0].authorization).not.toContain('key-a');
  });

  test('System One requests are routed too', async () => {
    const a = stub(['gemma3']);
    const b = stub(['tev']);
    const p = pool(endpoint(a, 'a'), endpoint(b, 'b'));
    await monitorFor(p).refresh();
    const answer = await p.systemOne({ model: 'tev', state: { x: 1 }, questions: { q: { type: 'noul', instructions: 'Is it?' } } });
    expect(answer.answers.q).toBeDefined();
    expect(b.requests.length).toBe(1);
    expect(a.requests.length).toBe(0);
  });

  test('runtime questions for performance go to the serving backend', async () => {
    const a = stub(['plain']);
    const b = stub(['gemma3:latest'], { ollama: true });
    const p = pool(endpoint(a, 'a'), endpoint(b, 'b'));
    await monitorFor(p).refresh();
    expect(await p.isOllama('gemma3:latest')).toBe(true);
    expect(await p.isOllama('plain')).toBe(false);
    expect(await p.isOllama('unknown')).toBe(false);
  });
});

describe('config', () => {
  test('the single-backend fields are one backend', () => {
    const [only] = resolveBackends({ enabled: true, baseURL: 'http://localhost/', port: 11434, apiKey: 'k' });
    expect(only).toEqual({ name: 'localhost:11434', baseURL: 'http://localhost', port: 11434, apiKey: 'k' });
  });

  test('a backends list wins, with default names', () => {
    const list = resolveBackends({ enabled: true, baseURL: 'http://ignored', port: 1, backends: [
      { name: 'mac', baseURL: 'http://localhost', port: 11434 },
      { baseURL: 'http://192.168.1.40', port: 8000, apiKey: 'x' },
    ] });
    expect(list.map((b) => b.name)).toEqual(['mac', '192.168.1.40:8000']);
    expect(list[1].apiKey).toBe('x');
  });

  test('bad backends are reported', () => {
    expect(backendsProblems([])[0]).toContain('is empty');
    expect(backendsProblems('x')[0]).toContain('must be a list');
    const problems = backendsProblems([
      { baseURL: 'ftp://x', port: 1 },
      { baseURL: 'http://a', port: 0 },
      { name: 'same', baseURL: 'http://b', port: 1 },
      { name: 'same', baseURL: 'http://c', port: 1 },
      { baseURL: 'http://d', port: 2, apiKey: 3 },
      { baseURL: 'http://d', port: 2 },
    ]);
    expect(problems.some((m) => m.includes('[0].baseURL` must be an http'))).toBe(true);
    expect(problems.some((m) => m.includes('[1].port`'))).toBe(true);
    expect(problems.some((m) => m.includes('"same" is used by another backend'))).toBe(true);
    expect(problems.some((m) => m.includes('[4].apiKey` must be a string'))).toBe(true);
    expect(problems.some((m) => m.includes('listed twice'))).toBe(true);
  });

  test('validateEnvironment checks the list instead of the single fields', () => {
    const env = withDefaults({ local: { enabled: true, privateTopic: 't' } } as any);
    env.models.backends = [{ baseURL: 'nope', port: 99999 }];
    const errors = validateEnvironment(env);
    expect(errors.some((m) => m.includes('models.backends[0].baseURL'))).toBe(true);
    expect(errors.some((m) => m.includes('`models.baseURL`'))).toBe(false);
  });

  test('a config file with both forms is refused', () => {
    expect(() => mergeConfig({ models: { enabled: true, baseURL: 'http://localhost', backends: [{ baseURL: 'http://a', port: 1 }] } } as any))
      .toThrow(ConfigError);
  });

  test('a backends config drops the default single backend, so config show output loads again', () => {
    const env = mergeConfig({ models: { enabled: true, backends: [{ baseURL: 'http://a', port: 1 }] } } as any);
    expect(env.models.baseURL).toBeUndefined();
    expect(env.models.port).toBeUndefined();
    expect(() => mergeConfig(toJsonConfig(env) as any)).not.toThrow();
  });

  test('a single-backend config is unchanged', () => {
    const env = mergeConfig({ models: { enabled: true, baseURL: 'http://localhost', port: 1234 } } as any);
    expect(env.models.baseURL).toBe('http://localhost');
    expect(env.models.port).toBe(1234);
    expect(env.models.backends).toBeUndefined();
  });
});
