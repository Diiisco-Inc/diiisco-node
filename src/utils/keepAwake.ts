import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { logger } from './logger';

/**
 * Keeps the machine from idling into sleep while the node runs.
 *
 * A node that serves a model has to be reachable, and a sleeping laptop is not:
 * its connection to the bootstrap relay drops and it silently falls off the
 * network. Rather than ask operators to wrap the node in `caffeinate`, the node
 * holds the operating system's own "don't idle-sleep" assertion for as long as
 * it is alive.
 *
 * What this does **not** do, on purpose: it does not stop the lid-close or an
 * explicit Sleep from putting the machine down (that is the user's decision, and
 * fighting it would be hostile), and it does not keep the display on.
 *
 * The assertion is always held by a small child process tied to this one's
 * lifetime, so it cannot outlive the node even if the node is killed:
 *
 *   macOS    `caffeinate -i -w <pid>`   exits when the node does
 *   Windows  PowerShell holding `SetThreadExecutionState`, blocked on stdin
 *   Linux    `systemd-inhibit … cat`    holds the lock while stdin is open
 *
 * For the last two the child's stdin is a pipe from the node: when the node
 * dies the pipe closes, the child reads EOF and exits, releasing the assertion.
 */

export interface KeepAwakeStrategy {
  /** Shown in the log, e.g. `caffeinate`. */
  name: string;
  command: string;
  args: string[];
  /** True when the child must be held open by a stdin pipe from this process. */
  holdsStdin: boolean;
}

/** `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`: stay awake until this thread says otherwise. */
const WINDOWS_SCRIPT = `
Add-Type -Namespace DIIISCO -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[void][DIIISCO.Power]::SetThreadExecutionState(0x80000001)
[void][Console]::In.ReadToEnd()
`.trim();

/**
 * Pick how to stay awake on this platform, or `null` when there is no way (an
 * unsupported platform, or the helper is not installed). Pure: everything it
 * needs is passed in, so each platform is testable from any machine.
 */
export function chooseStrategy(
  platform: NodeJS.Platform,
  pid: number,
  available: (command: string) => boolean
): KeepAwakeStrategy | null {
  if (platform === 'darwin' && available('caffeinate')) {
    // `-i` stops idle sleep only. Not `-d`: a headless node has no use for the
    // display staying on.
    return { name: 'caffeinate', command: 'caffeinate', args: ['-i', '-w', String(pid)], holdsStdin: false };
  }

  if (platform === 'win32' && available('powershell.exe')) {
    // -EncodedCommand (UTF-16LE base64) sidesteps every quoting rule between
    // Node's argument escaping and PowerShell's.
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    return {
      name: 'SetThreadExecutionState',
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      holdsStdin: true,
    };
  }

  if (platform === 'linux' && available('systemd-inhibit')) {
    return {
      name: 'systemd-inhibit',
      command: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=DIIISCO', '--why=Serving the DIIISCO network', '--mode=block', 'cat'],
      holdsStdin: true,
    };
  }

  return null;
}

/** Is `command` on the PATH? (`PATHEXT` is honoured on Windows.) */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  return dirs.some((dir) => extensions.some((ext) => existsSync(join(dir, command + ext))));
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  /** The pid the assertion is tied to. Defaults to this process. */
  pid?: number;
  available?: (command: string) => boolean;
  spawn?: typeof nodeSpawn;
  /** Waits before each restart of a helper that died. The list's length is the retry budget. */
  restartDelaysMs?: number[];
}

const DEFAULT_RESTART_DELAYS_MS = [5_000, 30_000, 120_000];

/**
 * Holds the assertion. Every method is safe to call at any time and none ever
 * throws: staying awake is a courtesy to the operator, never a reason for the
 * node to fail.
 */
export class KeepAwake {
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly available: (command: string) => boolean;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly restartDelaysMs: number[];

  private child: ChildProcess | null = null;
  private strategy: KeepAwakeStrategy | null = null;
  private stopping = false;
  private started = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: KeepAwakeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.available = options.available ?? ((command) => commandOnPath(command));
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
  }

  /** Whether the machine is currently being held awake. */
  get active(): boolean {
    return this.child !== null;
  }

  /** Begin holding the machine awake. Idempotent. Returns whether it is active. */
  start(): boolean {
    if (this.started) return this.active;
    this.started = true;
    this.stopping = false;

    this.strategy = chooseStrategy(this.platform, this.pid, this.available);
    if (!this.strategy) {
      logger.info(`💤 Cannot keep this machine awake on ${this.platform} (no supported helper found) — it may sleep while the node runs.`);
      return false;
    }

    this.launch();
    if (this.active) logger.info(`☕ Holding this machine awake while the node runs (${this.strategy.name}).`);
    return this.active;
  }

  /** Release the assertion. Idempotent. */
  stop(): void {
    this.stopping = true;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  private launch(): void {
    const strategy = this.strategy;
    if (!strategy) return;

    let child: ChildProcess;
    try {
      child = this.spawnFn(strategy.command, strategy.args, {
        stdio: [strategy.holdsStdin ? 'pipe' : 'ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      this.giveUp(`could not start ${strategy.command}: ${(err as Error).message}`);
      return;
    }

    this.child = child;
    // The helper must never be what keeps the node alive, nor hold the event
    // loop open at shutdown.
    child.unref();
    (child.stdin as any)?.unref?.();
    // A broken pipe on a dying helper is not worth an unhandled error.
    child.stdin?.on('error', () => {});

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child === child) this.child = null;
      this.giveUp(`${strategy.command} failed to run: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // a helper we already replaced or stopped
      this.child = null;
      if (this.stopping) return;
      this.scheduleRestart(`${strategy.command} exited (${signal ?? `code ${code}`})`);
    });
  }

  private scheduleRestart(reason: string): void {
    const delay = this.restartDelaysMs[this.restarts];
    if (delay === undefined) {
      this.giveUp(`${reason}; not restarting it again`);
      return;
    }
    this.restarts += 1;
    logger.warn(`⚠️ ${reason} — restarting it in ${Math.round(delay / 1000)}s so the machine stays awake.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.launch();
    }, delay);
    this.restartTimer.unref?.();
  }

  private giveUp(reason: string): void {
    logger.warn(`⚠️ The machine is no longer being held awake: ${reason}.`);
  }
}
