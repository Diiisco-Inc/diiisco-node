/**
 * Operator-facing hardening (release/1.0.9 review, plan 011): re-running
 * `diiisco setup` keeps hand-edited settings, and a node's peer identity is
 * never silently replaced or left world-readable.
 *
 * Driven against the source (`bun src/cli.ts`, `PeerIdManager`) rather than the
 * compiled binary, in a throwaway DIIISCO_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import environment from '../src/environment/runtime';
import { PeerIdManager } from '../src/libp2p/peerIdManager';
import { makeHome, removeHome, repoRoot } from './helpers';

describe('diiisco setup keeps what it does not ask about', () => {
  let home: string;
  beforeAll(() => { home = makeHome('diiisco-setup-merge-'); });
  afterAll(() => removeHome(home));

  test('models.kinds, availability, api.host and the status-page tuning survive a re-run', () => {
    writeFileSync(join(home, 'diiisco.config.json'), JSON.stringify({
      models: {
        enabled: true, baseURL: 'http://localhost', port: 11434, apiKey: '',
        kinds: { 'tev-*': 'decision' },
        availability: { checkIntervalMs: 12345 },
        chargePer1KTokens: { default: 0.002 },
      },
      api: {
        enabled: true, bearerAuthentication: false, keys: ['diiisco'], port: 8080,
        host: '127.0.0.1', corsOrigins: ['https://app.example.com'], profileWaitTime: 777, profileCacheTtl: 888,
      },
      local: { enabled: true, privateTopic: 'merge-test/models/1.0.0' },
    }), { mode: 0o600 });

    const result = spawnSync('bun', ['src/cli.ts', 'setup', '--local', '--yes', '--print', '--models-url', 'http://localhost:11434'], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DIIISCO_HOME: home, NO_COLOR: '1' },
    });
    expect(result.status).toBe(0);

    const config = JSON.parse(result.stdout);
    expect(config.models.kinds).toEqual({ 'tev-*': 'decision' });
    expect(config.models.availability).toEqual({ checkIntervalMs: 12345 });
    expect(config.models.chargePer1KTokens).toEqual({ default: 0.002 });
    expect(config.api.host).toBe('127.0.0.1');
    expect(config.api.corsOrigins).toEqual(['https://app.example.com']);
    expect(config.api.profileWaitTime).toBe(777);
    expect(config.api.profileCacheTtl).toBe(888);
    expect(config.local.privateTopic).toBe('merge-test/models/1.0.0');
  });
});

describe('peer identity file', () => {
  let home: string;
  const saved = environment.peerIdStorage.path;
  const file = () => join(home, 'diiisco-peer-id.protobuf');

  beforeAll(() => {
    home = makeHome('diiisco-peerid-guard-');
    environment.peerIdStorage.path = home;
  });
  afterAll(() => {
    environment.peerIdStorage.path = saved;
    removeHome(home);
  });

  test('an unreadable identity is an error, and the file is left exactly as it was', async () => {
    const damaged = Buffer.from('truncated, not a protobuf key');
    writeFileSync(file(), damaged);

    await expect(PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf')).rejects.toThrow(/Could not read the peer identity/);
    expect(readFileSync(file()).equals(damaged)).toBe(true);
  });

  test.skipIf(process.platform === 'win32')('a new identity is written owner-only, and an old world-readable one is tightened', async () => {
    writeFileSync(file(), privateKeyToProtobuf(await generateKeyPair('Ed25519')), { mode: 0o644 });
    chmodSync(file(), 0o644);
    const before = readFileSync(file());

    const { peerId } = await PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf');
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    // Loading does not rewrite the identity.
    expect(readFileSync(file()).equals(before)).toBe(true);
    expect(peerId.toString().length).toBeGreaterThan(10);

    // Fresh start, no file: created 0600.
    const fresh = makeHome('diiisco-peerid-fresh-');
    try {
      environment.peerIdStorage.path = fresh;
      await PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf');
      expect(existsSync(join(fresh, 'diiisco-peer-id.protobuf'))).toBe(true);
      expect(statSync(join(fresh, 'diiisco-peer-id.protobuf')).mode & 0o777).toBe(0o600);
    } finally {
      environment.peerIdStorage.path = home;
      removeHome(fresh);
    }
  });
});
