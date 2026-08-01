import { spawn } from 'node:child_process';
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  copyFileSync,
  truncateSync,
} from 'node:fs';
import { daemonStatePath, ensureHome, logFile, rotatedLogFile } from './paths';
import { isCompiled, version } from './version';

/** The internal argument the CLI passes to itself when self-daemonizing. */
export const DAEMON_ARG = '__daemon';

/** Rotate at 10 MB, keeping one previous file (2 × 10 MB total). */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface DaemonState {
  pid: number;
  startedAt: string;
  endpoint: string;
  version: string;
  owner: string;
}

/** Who started the daemon — `"cli"` unless a front-end (e.g. the desktop app) says otherwise. */
export function daemonOwner(): string {
  const owner = process.env.DIIISCO_OWNER?.trim();
  return owner && owner !== '' ? owner : 'cli';
}

export function readDaemonState(): DaemonState | null {
  const path = daemonStatePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed?.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date(0).toISOString(),
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      owner: typeof parsed.owner === 'string' ? parsed.owner : 'unknown',
    };
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  ensureHome();
  writeFileSync(daemonStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function removeDaemonState(): void {
  try {
    unlinkSync(daemonStatePath());
  } catch {
    // Already gone.
  }
}

/** Is this pid a live process we are allowed to signal? */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === 'EPERM';
  }
}

/**
 * The running daemon, or `null`. A state file whose pid is dead is stale: it is
 * removed so the next `start` is not blocked by a crash that skipped cleanup.
 */
export function liveDaemon(): { state: DaemonState | null; stale: boolean } {
  const state = readDaemonState();
  if (!state) return { state: null, stale: false };
  if (isAlive(state.pid)) return { state, stale: false };
  removeDaemonState();
  return { state: null, stale: true };
}

/**
 * How to re-spawn ourselves as the detached daemon.
 *
 * Compiled (`bun build --compile`): `process.execPath` *is* the `diiisco`
 * binary and the entry script lives in Bun's virtual filesystem, so the binary
 * is invoked with the daemon argument alone.
 *
 * Source (`bun run src/cli.ts`, `node dist/cli.js`): `execPath` is the runtime
 * and the script path has to be passed through.
 */
export function daemonCommand(): { command: string; args: string[] } {
  const script = process.argv[1];
  const compiled = isCompiled() || !script || !existsSync(script);
  if (compiled) return { command: process.execPath, args: [DAEMON_ARG] };
  return { command: process.execPath, args: [script, DAEMON_ARG] };
}

/**
 * Size-based rotation. Called before the parent opens the log for the daemon,
 * so the fd it hands over always points at a file below the cap.
 */
export function rotateLogsIfNeeded(): void {
  const current = logFile();
  try {
    if (!existsSync(current)) return;
    if (statSync(current).size < LOG_MAX_BYTES) return;
    copyFileSync(current, rotatedLogFile());
    truncateSync(current, 0);
  } catch {
    // Rotation is best effort — never block a start over it.
  }
}

/**
 * In-daemon rotation watcher.
 *
 * The daemon's stdout/stderr are an inherited append-mode fd, so the file
 * cannot be renamed out from under it; instead the contents are copied aside
 * and the file truncated in place, which an append-mode fd follows correctly.
 */
export function startLogRotationWatcher(intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(rotateLogsIfNeeded, intervalMs);
  timer.unref?.();
  return timer;
}

export interface HealthProbe {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
}

/** `GET {endpoint}{path}` with a timeout, never throwing. */
export async function probe(endpoint: string, path: string, timeoutMs = 2000): Promise<HealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain' },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body, error: null };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    return { ok: false, status: null, body: null, error: aborted ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `/health` until it answers or the deadline passes. */
export async function waitForHealth(endpoint: string, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe(endpoint, '/health', Math.min(2000, timeoutMs));
    if (result.ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SpawnResult {
  pid: number;
  logFile: string;
}

/**
 * Re-spawn this executable detached, with stdio redirected to the log file, and
 * record the result in `daemon.json`. Does not wait for `/health`; the caller
 * decides how long to wait and what to report.
 */
export function spawnDaemon(endpoint: string): SpawnResult {
  ensureHome();
  rotateLogsIfNeeded();

  const out = openSync(logFile(), 'a');
  try {
    const { command, args } = daemonCommand();
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, DIIISCO_OWNER: daemonOwner() },
      windowsHide: true,
    });

    if (child.pid === undefined) {
      throw new Error('the operating system did not return a pid for the daemon process');
    }

    child.unref();

    writeDaemonState({
      pid: child.pid,
      startedAt: new Date().toISOString(),
      endpoint,
      version: version(),
      owner: daemonOwner(),
    });

    return { pid: child.pid, logFile: logFile() };
  } finally {
    closeSync(out);
  }
}

export type StopOutcome = 'stopped' | 'killed' | 'not-running' | 'stale';

/** SIGTERM, wait out the grace period, then SIGKILL. Always clears the state file. */
export async function stopDaemon(graceMs = 10_000, pollMs = 200): Promise<{ outcome: StopOutcome; pid: number | null }> {
  const state = readDaemonState();
  if (!state) return { outcome: 'not-running', pid: null };

  if (!isAlive(state.pid)) {
    removeDaemonState();
    return { outcome: 'stale', pid: state.pid };
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    removeDaemonState();
    return { outcome: 'stale', pid: state.pid };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(state.pid)) {
      removeDaemonState();
      return { outcome: 'stopped', pid: state.pid };
    }
    await sleep(pollMs);
  }

  try {
    process.kill(state.pid, 'SIGKILL');
  } catch {
    // Exited between the last poll and now.
  }
  removeDaemonState();
  return { outcome: 'killed', pid: state.pid };
}
