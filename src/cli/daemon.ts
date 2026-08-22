import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { requestShutdown } from './control';
import { isCompiled, version } from './version';

/** The internal argument the CLI passes to itself when self-daemonizing. */
export const DAEMON_ARG = '__daemon';

/** Rotate at 10 MB, keeping one previous file (2 × 10 MB total). */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Where and how to reach the running daemon's control channel (`control.ts`).
 * Written by the daemon itself once it is listening; absent on a daemon started
 * by a version of the CLI that predates the control channel, which is why every
 * caller treats it as optional and falls back to signals.
 */
export interface DaemonControl {
  port: number;
  /** 32 random bytes, hex. Secret: `daemon.json` is `0600` and this is never logged. */
  token: string;
}

export interface DaemonState {
  pid: number;
  startedAt: string;
  endpoint: string;
  version: string;
  owner: string;
  control?: DaemonControl;
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
    const control =
      typeof parsed?.control?.port === 'number' && typeof parsed?.control?.token === 'string'
        ? { port: parsed.control.port, token: parsed.control.token }
        : undefined;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date(0).toISOString(),
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      owner: typeof parsed.owner === 'string' ? parsed.owner : 'unknown',
      ...(control ? { control } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * `daemon.json` carries the control-channel token, so it is owner-only. The
 * mode argument only applies when the file is created, hence the explicit
 * chmod for a file left behind by an older CLI.
 */
export function writeDaemonState(state: DaemonState): void {
  ensureHome();
  const path = daemonStatePath();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and exotic filesystems have no POSIX mode bits.
  }
}

/**
 * Called by the daemon once its control channel is listening: merge the port
 * and token into the state file the *parent* wrote at spawn time.
 *
 * The parent writes `daemon.json` synchronously as soon as `spawn()` returns,
 * long before this process has finished booting, so in practice the file is
 * already there. The retry loop covers the reverse ordering (and a `serve`
 * whose state file has not appeared yet) without ever clobbering a state file
 * that belongs to a *different* daemon — the pid must match our own.
 */
export async function recordControlChannel(control: DaemonControl, timeoutMs = 15_000, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readDaemonState();
    if (state && state.pid === process.pid) {
      writeDaemonState({ ...state, control });
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
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

/**
 * How the daemon went away.
 *
 * - `stopped`   — it acknowledged the control instruction and exited on its own,
 *                 having run `Application.shutdown()` to completion.
 * - `signalled` — the control channel was unavailable or ineffective and SIGTERM
 *                 (POSIX) / `taskkill` (Windows) finished the job. On POSIX this
 *                 is still a graceful shutdown; on Windows it is not.
 * - `killed`    — nothing short of SIGKILL / `taskkill /F` worked. The node did
 *                 **not** shut down cleanly and the caller must say so.
 */
export type StopOutcome = 'stopped' | 'signalled' | 'killed' | 'not-running' | 'stale';

export interface StopResult {
  outcome: StopOutcome;
  pid: number | null;
  /** Why the control channel was not used, or why it did not finish the job. */
  controlError: string | null;
}

/** Grace given to a daemon that acknowledged the control instruction. */
const CONTROL_GRACE_MS = 15_000;
/** Grace given after SIGTERM / `taskkill`, before the hard kill. */
const SIGNAL_GRACE_MS = 10_000;

async function waitForExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Ask the process to terminate.
 *
 * POSIX gets SIGTERM, which `serve` handles by running `Application.shutdown()`.
 *
 * **Windows has no SIGTERM.** `process.kill(pid, 'SIGTERM')` there is
 * `TerminateProcess` — an unconditional kill with no chance to clean up — so it
 * is never used as the "polite" step. `taskkill` without `/F` posts WM_CLOSE /
 * CTRL_BREAK to the process tree, which is the closest Windows equivalent, and
 * the hard kill below is what actually reaps a console process that ignores it.
 * The graceful path on Windows is the control channel; this is the backstop for
 * a daemon that never recorded one.
 */
function requestTermination(pid: number): boolean {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true });
    // A console process with no message loop answers "can only be terminated
    // forcefully" and exits non-zero. Waiting out a grace period for a request
    // the OS has already refused just delays the inevitable, so say so and let
    // the caller escalate immediately.
    return result.status === 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone; waitForExit will confirm that on its first poll.
  }
  return true;
}

function forceKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Exited between the last poll and now.
  }
}

/**
 * Stop the daemon, preferring a real graceful shutdown.
 *
 *   1. Control channel (`control.ts`) — the daemon runs `Application.shutdown()`
 *      itself: API server drained, GossipSub topics unsubscribed, libp2p closed,
 *      any in-flight x402 settlement given the chance to finish.
 *   2. SIGTERM / `taskkill` — the pre-existing behaviour, kept so a daemon
 *      started by an older CLI (no `control` block in its `daemon.json`) still
 *      stops exactly as it used to.
 *   3. SIGKILL / `taskkill /F`.
 *
 * Always clears the state file.
 */
export async function stopDaemon(signalGraceMs = SIGNAL_GRACE_MS, pollMs = 200): Promise<StopResult> {
  const state = readDaemonState();
  if (!state) return { outcome: 'not-running', pid: null, controlError: null };

  if (!isAlive(state.pid)) {
    removeDaemonState();
    return { outcome: 'stale', pid: state.pid, controlError: null };
  }

  let controlError: string | null = null;

  if (state.control) {
    const asked = await requestShutdown(state.control.port, state.control.token);
    if (asked.ok) {
      if (await waitForExit(state.pid, CONTROL_GRACE_MS, pollMs)) {
        removeDaemonState();
        return { outcome: 'stopped', pid: state.pid, controlError: null };
      }
      controlError = `the node acknowledged the shutdown request but had not exited after ${CONTROL_GRACE_MS / 1000}s`;
    } else {
      controlError = asked.error;
    }
  } else {
    controlError = 'this daemon did not record a control channel (started by an older diiisco)';
  }

  const accepted = requestTermination(state.pid);
  if (await waitForExit(state.pid, accepted ? signalGraceMs : 0, pollMs)) {
    removeDaemonState();
    return { outcome: 'signalled', pid: state.pid, controlError };
  }

  forceKill(state.pid);
  await waitForExit(state.pid, 2_000, pollMs);
  removeDaemonState();
  return { outcome: 'killed', pid: state.pid, controlError };
}
