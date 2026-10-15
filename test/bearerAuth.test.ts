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
