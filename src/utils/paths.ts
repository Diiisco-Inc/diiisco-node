import { homedir } from 'node:os';
import { isAbsolute, join, posix, resolve, win32 } from 'node:path';

/**
 * Home-directory and `~` resolution, shared by the CLI, the environment
 * defaults and the libp2p layer.
 *
 * This lives in `utils/` rather than `cli/` because `src/libp2p/peerIdManager.ts`
 * needs it and must not depend on the CLI layer. Before it did, that file
 * expanded `~` with `process.env.HOME` — which is unset on Windows, so
 * `~/.diiisco` became `/.diiisco` and a node's long-term identity was written to
 * the root of the system drive.
 */

/** Every candidate for the user's home directory was empty or a filesystem root. */
export class HomeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HomeResolutionError';
  }
}

export interface HomeResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to `os.homedir()`, swallowing its throw. */
  homedir?: () => string | undefined;
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    // uv_os_homedir can fail outright on a stripped environment.
    return undefined;
  }
}

/**
 * A filesystem root is never anybody's home directory. Accepting one is exactly
 * how `.diiisco` ends up at `C:\`, so it is rejected rather than used.
 */
function usableHome(candidate: string | undefined, flavour: typeof win32 | typeof posix): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (trimmed === '') return null;
  if (flavour.parse(trimmed).root === trimmed) return null;
  return trimmed;
}

/** `%HOMEDRIVE%%HOMEPATH%`, the Windows pair that survives when `USERPROFILE` does not. */
function homeDrivePath(env: NodeJS.ProcessEnv): string | undefined {
  const drive = env.HOMEDRIVE?.trim();
  const path = env.HOMEPATH?.trim();
  if (!drive || !path) return undefined;
  return `${drive}${path}`;
}

/**
 * The user's home directory, resolved in the order that is actually correct for
 * the platform.
 *
 * On Windows `HOME` is normally unset — cmd.exe and PowerShell set `USERPROFILE`
 * and `HOMEDRIVE`/`HOMEPATH` — so it is consulted last, not first.
 *
 * There is deliberately **no** `process.cwd()` fallback: silently treating the
 * working directory as home is what produced `C:\.diiisco`. A process launched
 * with an environment this broken should say so, and `DIIISCO_HOME` is the
 * escape hatch (`diiiscoHome()` checks it before ever calling this).
 */
export function resolveUserHome(options: HomeResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const readHomedir = options.homedir ?? safeHomedir;
  const windows = platform === 'win32';
  const flavour = windows ? win32 : posix;

  const candidates = windows
    ? [env.USERPROFILE, homeDrivePath(env), readHomedir(), env.HOME]
    : [readHomedir(), env.HOME];

  for (const candidate of candidates) {
    const usable = usableHome(candidate, flavour);
    if (usable) return usable;
  }

  const tried = windows ? '%USERPROFILE%, %HOMEDRIVE%%HOMEPATH%, os.homedir(), $HOME' : 'os.homedir(), $HOME';
  throw new HomeResolutionError(
    `Could not work out your home directory (tried ${tried}). ` +
      'Set DIIISCO_HOME to the directory DIIISCO should keep its files in.'
  );
}

export function userHome(): string {
  return resolveUserHome();
}

/** Expand a leading `~` in a config path. Anything else is returned unchanged. */
export function expandTilde(p: string): string {
  if (p === '~') return userHome();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(userHome(), p.slice(2));
  return p;
}

/**
 * Expand `~` and make the result absolute. This is what anything that will
 * `mkdir`, read or write at the path should use — a relative remainder must not
 * survive to be resolved against whatever cwd the daemon happened to inherit.
 */
export function resolvePath(p: string): string {
  const expanded = expandTilde(p.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** The DIIISCO home directory (`DIIISCO_HOME`, else `~/.diiisco`). */
export function diiiscoHome(): string {
  const override = process.env.DIIISCO_HOME;
  if (override && override.trim() !== '') return resolvePath(override);
  return join(userHome(), '.diiisco');
}
