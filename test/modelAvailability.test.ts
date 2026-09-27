/**
 * The live model-availability monitor (`src/utils/modelAvailability.ts`).
 *
 * Like the adapter tests, these run against the **source** rather than the
 * compiled binary: the monitor is a small state machine over one backend call,
 * and the failure it guards against — a node that keeps quoting for models its
 * inference backend can no longer serve, hanging every requester that picks it
 * — is invisible to a CLI smoke test.
 */
import { describe, expect, test } from 'bun:test';
import { ModelAvailabilityMonitor } from '../src/utils/modelAvailability';
import type { OpenAIInferenceModel } from '../src/utils/models';

const model = (id: string) => ({ id, object: 'model', created: 0, owned_by: 'test' });

/** A stand-in backend that records calls and can be told how to behave. */
function fakeBackend(behaviour: (call: number, signal?: AbortSignal) => Promise<any[]>) {
  let calls = 0;
  return {
    get calls() { return calls; },
    backend: {
      getModels: (signal?: AbortSignal) => {
        calls += 1;
        return behaviour(calls, signal);
      },
    } as unknown as OpenAIInferenceModel,
  };
}

const monitorFor = (backend: OpenAIInferenceModel, options = {}) =>
  new ModelAvailabilityMonitor(backend, { enabled: true, checkIntervalMs: 0, ...options });

describe('ModelAvailabilityMonitor', () => {
  test('a healthy probe publishes the backend model ids', async () => {
    const { backend } = fakeBackend(async () => [model('gemma3'), model('llama3')]);
    const monitor = monitorFor(backend);

    await monitor.refresh();

    expect(monitor.isHealthy()).toBe(true);
    expect(monitor.list().sort()).toEqual(['gemma3', 'llama3']);
    expect(monitor.isAvailable('gemma3')).toBe(true);
    expect(monitor.isAvailable('mistral')).toBe(false);
  });

  test('non-model entries are filtered out', async () => {
    const { backend } = fakeBackend(async () => [
      model('gemma3'),
      { id: 'text-embedding', object: 'embedding' },
    ]);
    const monitor = monitorFor(backend);

    await monitor.refresh();

    expect(monitor.list()).toEqual(['gemma3']);
  });

  test('an unreachable backend empties the set and never rejects', async () => {
    const { backend } = fakeBackend(async () => { throw new Error('ECONNREFUSED'); });
    const monitor = monitorFor(backend);

    const ids = await monitor.refresh();

    expect(ids).toEqual([]);
    expect(monitor.isHealthy()).toBe(false);
    expect(monitor.list()).toEqual([]);
    expect(await monitor.ensureAvailable('gemma3')).toBe(false);
  });

  test('the set comes back when the backend recovers', async () => {
    const { backend } = fakeBackend(async (call) => {
      if (call === 1) throw new Error('ECONNREFUSED');
      return [model('gemma3')];
    });
    const monitor = monitorFor(backend);

    await monitor.refresh();
    expect(monitor.list()).toEqual([]);

    await monitor.refresh();
    expect(monitor.isHealthy()).toBe(true);
    expect(monitor.list()).toEqual(['gemma3']);
  });

  test('concurrent probes are single-flight', async () => {
    let release: (models: any[]) => void = () => {};
    const pending = new Promise<any[]>((resolve) => { release = resolve; });
    const fake = fakeBackend(() => pending);
    const monitor = monitorFor(fake.backend);

    const answers = Promise.all([
      monitor.ensureAvailable('gemma3'),
      monitor.ensureAvailable('gemma3'),
      monitor.ensureAvailable('gemma3'),
    ]);
    release([model('gemma3')]);

    expect(await answers).toEqual([true, true, true]);
    expect(fake.calls).toBe(1);
  });

  test('a fresh snapshot answers without touching the backend', async () => {
    const fake = fakeBackend(async () => [model('gemma3')]);
    const monitor = monitorFor(fake.backend, { freshForMs: 60_000 });

    await monitor.ensureAvailable('gemma3');
    await monitor.ensureAvailable('gemma3');
    await monitor.ensureAvailable('gemma3');

    expect(fake.calls).toBe(1);
  });

  test('a stale snapshot is re-probed on the quote path', async () => {
    const fake = fakeBackend(async () => [model('gemma3')]);
    const monitor = monitorFor(fake.backend, { freshForMs: 0 });

    await monitor.ensureAvailable('gemma3');
    await monitor.ensureAvailable('gemma3');

    expect(fake.calls).toBe(2);
  });

  test('invalidate() forces the next check to re-probe', async () => {
    const fake = fakeBackend(async () => [model('gemma3')]);
    const monitor = monitorFor(fake.backend, { freshForMs: 60_000 });

    await monitor.ensureAvailable('gemma3');
    expect(fake.calls).toBe(1);

    monitor.invalidate();
    await monitor.ensureAvailable('gemma3');
    expect(fake.calls).toBe(2);
  });

  test('a backend that never answers is treated as unavailable', async () => {
    // Honours the abort signal the monitor passes, as a real HTTP client does.
    const { backend } = fakeBackend((_call, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const monitor = monitorFor(backend, { timeoutMs: 50 });

    const startedAt = Date.now();
    expect(await monitor.ensureAvailable('gemma3')).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(monitor.isHealthy()).toBe(false);
  });

  test('models.enabled: false leaves the monitor inert', async () => {
    const fake = fakeBackend(async () => [model('gemma3')]);
    const monitor = new ModelAvailabilityMonitor(fake.backend, { enabled: false });

    monitor.start();
    expect(await monitor.refresh()).toEqual([]);
    expect(await monitor.ensureAvailable('gemma3')).toBe(false);
    expect(monitor.list()).toEqual([]);
    expect(fake.calls).toBe(0);
    monitor.stop();
  });
});
