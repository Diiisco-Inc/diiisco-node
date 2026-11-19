/**
 * Bearer auth middleware (issue #90): a rejected key must never be reflected
 * back in the response, since error bodies end up in client, proxy and
 * monitoring logs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import environment from '../src/environment/runtime';
import { requireBearer } from '../src/utils/endpoint';

const VALID_KEY = 'valid-key-1234';

function run(headers: Record<string, string>) {
  const req: any = { headers };
  const result: { status?: number; body?: any; nexted: boolean } = { nexted: false };
  const res: any = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  };
  requireBearer(req, res, () => {
    result.nexted = true;
  });
  return { req, ...result };
}

describe('requireBearer', () => {
  let originalKeys: string[];

  beforeAll(() => {
    originalKeys = environment.api.keys;
    environment.api.keys = [VALID_KEY];
  });

  afterAll(() => {
    environment.api.keys = originalKeys;
  });

  test('rejects an unknown key without echoing it', () => {
    const wrong = 'sk-mistyped-secret-9876';
    const { status, body, nexted } = run({ authorization: `Bearer ${wrong}` });
    expect(status).toBe(401);
    expect(nexted).toBe(false);
    expect(body.error.type).toBe('authentication_error');
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(wrong);
    expect(serialised).not.toContain(wrong.slice(-4));
  });

  test('rejects an unknown x-api-key without echoing it', () => {
    const wrong = 'sk-ant-wrong-4321';
    const { status, body } = run({ 'x-api-key': wrong });
    expect(status).toBe(401);
    expect(JSON.stringify(body)).not.toContain(wrong);
  });

  test('asks for a key when none is supplied', () => {
    const { status, body, nexted } = run({});
    expect(status).toBe(401);
    expect(nexted).toBe(false);
    expect(body.error.message).toBe('You must provide an API key.');
  });

  test('accepts a valid key and records the auth info', () => {
    const { req, nexted, status } = run({ authorization: `Bearer ${VALID_KEY}` });
    expect(nexted).toBe(true);
    expect(status).toBeUndefined();
    expect(req.auth).toEqual({ token: VALID_KEY, type: 'opaque' });
  });
});

describe('requireBearer key comparison', () => {
  let originalKeys: string[];
  beforeAll(() => { originalKeys = environment.api.keys; });
  afterAll(() => { environment.api.keys = originalKeys; });

  test('any of several keys is accepted, whitespace around a configured key is ignored', () => {
    environment.api.keys = ['  first-key  ', 'second-key'];
    expect(run({ authorization: 'Bearer first-key' }).nexted).toBe(true);
    expect(run({ 'x-api-key': 'second-key' }).nexted).toBe(true);
  });

  test('a prefix, an extension or a different-length key is refused', () => {
    environment.api.keys = ['correct-horse-battery'];
    for (const wrong of ['correct-horse', 'correct-horse-battery-staple', 'c', 'Correct-horse-battery']) {
      expect(run({ authorization: `Bearer ${wrong}` }).status).toBe(401);
    }
  });

  test('with no keys configured nothing authenticates', () => {
    environment.api.keys = [];
    expect(run({ authorization: 'Bearer anything' }).status).toBe(401);
    environment.api.keys = ['  '];
    expect(run({ authorization: 'Bearer ' }).status).toBe(401);
  });
});

describe('API key defaults', () => {
  test('no key ships by default', async () => {
    const { createDefaultEnvironment } = await import('../src/environment/defaults');
    expect(createDefaultEnvironment().api.keys).toEqual([]);
  });

  test('authentication with the well-known default key is a validation error', async () => {
    const { createDefaultEnvironment } = await import('../src/environment/defaults');
    const { validateEnvironment } = await import('../src/environment/validate');
    const env = createDefaultEnvironment();
    env.local = { enabled: true, privateTopic: 'key-default-test/models/1.0.0' };
    env.api.bearerAuthentication = true;

    env.api.keys = ['diiisco'];
    expect(validateEnvironment(env).join('\n')).toContain('well-known default key');
    env.api.keys = [' DIIISCO '];
    expect(validateEnvironment(env).join('\n')).toContain('well-known default key');
    env.api.keys = [];
    expect(validateEnvironment(env).join('\n')).toContain('`api.keys` is empty');
    env.api.keys = ['a-random-key-9f2c1b'];
    expect(validateEnvironment(env).filter((e) => e.includes('api.keys'))).toEqual([]);
  });

  test('the default key alongside authentication being off is not an error', async () => {
    const { createDefaultEnvironment } = await import('../src/environment/defaults');
    const { validateEnvironment } = await import('../src/environment/validate');
    const env = createDefaultEnvironment();
    env.local = { enabled: true, privateTopic: 'key-default-test/models/1.0.0' };
    env.api.bearerAuthentication = false;
    env.api.keys = ['diiisco'];
    expect(validateEnvironment(env).filter((e) => e.includes('api.keys'))).toEqual([]);
  });
});
