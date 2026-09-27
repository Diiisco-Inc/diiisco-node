import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diiiscoHome } from '../utils/paths';

/**
 * Every runtime artefact the CLI and the desktop app share lives under one
 * directory so `diiisco status` reflects a node started from the GUI and vice
 * versa:
 *
 *   ~/.diiisco/
 *     diiisco.config.json         user config (Environment shape; see cli/config.ts)
 *     diiisco-peer-id.protobuf    peer identity
 *     daemon.json                 pid/state file
 *     logs/diiisco.log            daemon log (size-rotated, keep 2)
 *
 * `DIIISCO_HOME` overrides the location. `~` resolves via `os.homedir()`, which
 * is `%USERPROFILE%` on Windows.
 *
 * The resolution itself lives in `src/utils/paths.ts` — `src/libp2p/` needs it
 * too and must not import the CLI layer — and is re-exported here so every
 * existing `from '../paths'` import site is unaffected.
 */
export { diiiscoHome, expandTilde, resolvePath, userHome, HomeResolutionError } from '../utils/paths';

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

/** Create `~/.diiisco` (and `logs/`) if missing. Safe to call repeatedly. */
export function ensureHome(): string {
  const home = diiiscoHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(logDir(), { recursive: true });
  return home;
}
