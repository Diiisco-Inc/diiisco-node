/**
 * Peer-identity persistence across runtimes (spec §6.3 item 5).
 *
 * `~/.diiisco/diiisco-peer-id.protobuf` is a node's long-term identity: other
 * peers, relay reservations and the status pages all key off the peer id it
 * yields. During the Node → Bun transition the same file has to be readable by
 * both — a user who has been running `npm run node:start` and then installs the
 * binary must keep their identity, and the desktop app and the CLI must agree
 * on it in either direction.
 *
 * The test writes a key with one runtime and derives the peer id with the
 * other, both ways round, and then checks the file a real compiled daemon
 * leaves behind.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  NO_BINARY_REASON,
  binary,
  forceStop,
  freePort,
  makeHome,
  nodeAvailable,
  removeHome,
  repoRoot,
  run,
  writeOfflineConfig,
} from './helpers';

/**
 * Derive the peer id from a protobuf key file using **Node**, through the same
 * `@libp2p/crypto` entry point `PeerIdManager` uses.
 */
function peerIdViaNode(keyPath: string): string {
  const script = `
    import { readFileSync } from 'node:fs';
    import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
    import { peerIdFromPrivateKey } from '@libp2p/peer-id';
    const key = await privateKeyFromProtobuf(readFileSync(${JSON.stringify(keyPath)}));
    process.stdout.write(peerIdFromPrivateKey(key).toString());
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', script], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`node failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Write a fresh protobuf key file using **Node**, and report its peer id. */
function generateViaNode(keyPath: string): string {
  const script = `
    import { writeFileSync } from 'node:fs';
    import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
    import { peerIdFromPrivateKey } from '@libp2p/peer-id';
    const key = await generateKeyPair('Ed25519');
    writeFileSync(${JSON.stringify(keyPath)}, privateKeyToProtobuf(key));
    process.stdout.write(peerIdFromPrivateKey(key).toString());
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', script], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`node failed: ${result.stderr}`);
  return result.stdout.trim();
}

const haveNode = nodeAvailable();
const crossRuntime = haveNode ? describe : describe.skip;
if (!haveNode) console.warn('skipping the cross-runtime peer-id tests: node is not on PATH');

describe('peer identity', () => {
  let home: string;

  beforeAll(() => {
    home = makeHome('diiisco-peerid-');
  });

  afterAll(() => removeHome(home));

  test('a Bun-written key round-trips through Bun', async () => {
    const path = join(home, 'bun.protobuf');
    const key = await generateKeyPair('Ed25519');
    writeFileSync(path, privateKeyToProtobuf(key));

    const reloaded = await privateKeyFromProtobuf(readFileSync(path));
    expect(peerIdFromPrivateKey(reloaded).toString()).toBe(peerIdFromPrivateKey(key).toString());
  });

  crossRuntime('across runtimes', () => {
    test('a key written by Bun yields the same peer id under Node', async () => {
      const path = join(home, 'bun-to-node.protobuf');
      const key = await generateKeyPair('Ed25519');
      writeFileSync(path, privateKeyToProtobuf(key));

      expect(peerIdViaNode(path)).toBe(peerIdFromPrivateKey(key).toString());
    });

    test('a key written by Node yields the same peer id under Bun', async () => {
      const path = join(home, 'node-to-bun.protobuf');
      const expected = generateViaNode(path);

      const key = await privateKeyFromProtobuf(readFileSync(path));
      expect(peerIdFromPrivateKey(key).toString()).toBe(expected);
    });
  });
});

const daemonSuite = binary && haveNode ? describe : describe.skip;
if (!binary) console.warn(`skipping the daemon peer-id test: ${NO_BINARY_REASON}`);

daemonSuite('peer identity written by the compiled daemon', () => {
  let home: string;

  beforeAll(async () => {
    home = makeHome('diiisco-peerid-daemon-');
    writeOfflineConfig(home, await freePort());
  });

  afterAll(() => {
    forceStop(home);
    removeHome(home);
  });

  test('is a protobuf Node can read, and survives a restart', () => {
    const keyPath = join(home, 'diiisco-peer-id.protobuf');

    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    expect(existsSync(keyPath)).toBe(true);

    const first = peerIdViaNode(keyPath);
    expect(first).toMatch(/^12D3KooW/);

    // The identity must be stable across restarts — a node that regenerates it
    // loses its relay reservations and its status-page URL on every start.
    run(['stop'], { home, timeoutMs: 30_000 });
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    expect(peerIdViaNode(keyPath)).toBe(first);
    run(['stop'], { home, timeoutMs: 30_000 });
  }, 180_000);
});
