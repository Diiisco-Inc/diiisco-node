import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Every runtime artefact the CLI and the desktop app share lives under one
 * directory so `diiisco status` reflects a node started from the GUI and vice
 * versa:
 *
 *   ~/.diiisco/
 *     config.json                 user config (Environment shape)
 *     diiisco-peer-id.protobuf    peer identity
 *     daemon.json                 pid/state file
 *     logs/diiisco.log            daemon log (size-rotated, keep 2)
 *
 * `DIIISCO_HOME` overrides the location. `~` resolves via `os.homedir()`, which
 * is `%USERPROFILE%` on Windows.
 */
export function userHome(): string {
  return homedir() || process.env.HOME || process.env.USERPROFILE || process.cwd();
}

/** Expand a leading `~` in a config path. */
export function expandTilde(p: string): string {
  if (p === '~') return userHome();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(userHome(), p.slice(2));
  return p;
}

/** The DIIISCO home directory (`DIIISCO_HOME`, else `~/.diiisco`). */
export function diiiscoHome(): string {
  const override = process.env.DIIISCO_HOME;
  if (override && override.trim() !== '') {
    const expanded = expandTilde(override.trim());
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return join(userHome(), '.diiisco');
}

export function configPath(): string {
  return join(diiiscoHome(), 'config.json');
}

export function daemonStatePath(): string {
  return join(diiiscoHome(), 'daemon.json');
}

export function logDir(): string {
  return join(diiiscoHome(), 'logs');
}

export function logFile(): string {
  return join(logDir(), 'diiisco.log');
}

/** Rotated log (we keep exactly one previous file — 2 × LOG_MAX_BYTES total). */
export function rotatedLogFile(): string {
  return `${logFile()}.1`;
}

/** Marker written after the first-run notice has been shown once. */
export function firstRunMarkerPath(): string {
  return join(diiiscoHome(), '.first-run');
}

/** Create `~/.diiisco` (and `logs/`) if missing. Safe to call repeatedly. */
export function ensureHome(): string {
  const home = diiiscoHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(logDir(), { recursive: true });
  return home;
}
