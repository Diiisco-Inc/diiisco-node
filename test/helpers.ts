/**
 * Shared plumbing for the release smoke suite (spec §6.3).
 *
 * Every test that can drives the **compiled binary** rather than the source
 * tree: a compile that produces an unrunnable executable is the failure mode
 * this suite exists to catch, and `bun run src/cli.ts` would not catch it.
 *
 * Nothing here may touch the real `~/.diiisco`. Each test gets its own
 * directory under the OS temp dir and passes it through `DIIISCO_HOME`, which
 * relocates the config file, the peer identity, `daemon.json` and the logs
 * together.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The compiled executable for this host, or `null`.
 *
 * `DIIISCO_BINARY` lets CI point at an artifact downloaded from another job.
 * When there is no binary the suite skips rather than falling back to the
 * source tree — a green run against `src/` would say nothing about the release.
 */
export function compiledBinary(): string | null {
  const override = process.env.DIIISCO_BINARY?.trim();
  if (override) return existsSync(override) ? override : null;

  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (!os || !arch) return null;

  const path = join(repoRoot, 'dist', 'bin', `diiisco-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
  return existsSync(path) ? path : null;
}

export const binary = compiledBinary();

/** Message printed once when the suite skips, so a skip is never mysterious. */
export const NO_BINARY_REASON =
  'no compiled binary — run `bun scripts/build-binaries.mjs --host` (or set DIIISCO_BINARY)';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI to completion with an isolated home. Never throws on a non-zero exit. */
export function run(args: string[], options: { home?: string; env?: Record<string, string>; timeoutMs?: number } = {}): RunResult {
  if (!binary) throw new Error(NO_BINARY_REASON);
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    env: {
      ...process.env,
      ...(options.home ? { DIIISCO_HOME: options.home } : {}),
      // Keep colour codes out of the assertions.
      NO_COLOR: '1',
      ...options.env,
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * The same, without blocking the event loop.
 *
 * `spawnSync` stops this process servicing its own sockets, so any test that
 * stands up a stub HTTP server for the CLI to call must use this form — with
 * the sync variant the CLI's health probe simply times out.
 */
export function runAsync(
  args: string[],
  options: { home?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<RunResult> {
  if (!binary) throw new Error(NO_BINARY_REASON);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: {
        ...process.env,
        ...(options.home ? { DIIISCO_HOME: options.home } : {}),
        NO_COLOR: '1',
        ...options.env,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** A throwaway `DIIISCO_HOME`. The caller is responsible for `removeHome`. */
export function makeHome(prefix = 'diiisco-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/**
 * A config that starts a real node with no external dependencies at all: local
 * mode (no wallet), inference disabled (no Ollama) and no bootstrap servers (no
 * internet). Everything the lifecycle tests assert on is still exercised —
 * libp2p starts, the API binds, `/health` answers.
 */
export function writeOfflineConfig(home: string, port: number, extra: Record<string, unknown> = {}): string {
  const path = join(home, 'diiisco.config.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        models: { enabled: false, baseURL: 'http://localhost', port: 11434, apiKey: '' },
        api: { enabled: true, bearerAuthentication: false, keys: ['diiisco'], port },
        libp2pBootstrapServers: [],
        local: { enabled: true, privateTopic: `diiisco-test-${port}/models/1.0.0` },
        node: { displayName: 'smoke-test' },
        ...extra,
      },
      null,
      2
    ),
    { encoding: 'utf8', mode: 0o600 }
  );
  return path;
}

/** An OS-assigned free TCP port, released before it is handed back. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Can this host actually do UDP multicast? Container networks and locked-down
 * CI runners often cannot, and an mDNS test there is a false alarm rather than
 * a Bun regression — so the discovery tests skip instead of failing.
 */
export function multicastAvailable(timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const GROUP = '224.0.0.251';
    const PORT = 54_354;
    const rx = createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { rx.close(); } catch { /* already closed */ }
      resolve(ok);
    };

    rx.on('error', () => finish(false));
    rx.on('message', (msg) => finish(msg.toString() === 'diiisco-probe'));
    rx.bind(PORT, () => {
      try {
        rx.addMembership(GROUP);
      } catch {
        return finish(false);
      }
      const tx = createSocket({ type: 'udp4', reuseAddr: true });
      tx.bind(0, () => {
        try {
          tx.setMulticastTTL(1);
          tx.setMulticastLoopback(true);
        } catch {
          return finish(false);
        }
        tx.send('diiisco-probe', PORT, GROUP, () => tx.close());
      });
    });

    setTimeout(() => finish(false), timeoutMs);
  });
}

/** Is `node` on PATH? The cross-runtime tests need both runtimes. */
export function nodeAvailable(): boolean {
  const result = spawnSync('node', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

/** Fire-and-forget stop, for `afterEach` cleanup that must not throw. */
export function forceStop(home: string): void {
  try {
    run(['stop'], { home, timeoutMs: 20_000 });
  } catch {
    // The binary may be absent; the test that needed it has already skipped.
  }
}

export { spawn };
