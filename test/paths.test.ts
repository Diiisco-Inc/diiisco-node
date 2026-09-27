/**
 * Home-directory and `~` resolution.
 *
 * A node's peer identity used to be written to `C:\.diiisco` on Windows:
 * `src/libp2p/peerIdManager.ts` expanded `~` with `process.env.HOME`, which is
 * unset on Windows (cmd.exe and PowerShell set `USERPROFILE` and
 * `HOMEDRIVE`/`HOMEPATH`), so `'~/.diiisco'.replace('~', '')` produced
 * `/.diiisco` — the root of the system drive. DIIISCO Desktop resolved the home
 * correctly, looked in the user's profile, and could not find the node.
 *
 * These tests inject the platform and environment rather than depending on the
 * host, so the Windows ordering is covered from a Unix CI machine.
 */
import { describe, expect, test } from 'bun:test';
import { isAbsolute, join, win32 } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  HomeResolutionError,
  diiiscoHome,
  expandTilde,
  resolvePath,
  resolveUserHome,
  userHome,
} from '../src/utils/paths';
import { createDefaultEnvironment } from '../src/environment/defaults';
import { mergeConfig } from '../src/cli/config';

/** Nothing usable at all, so the candidate list is exercised to its end. */
const noHomedir = () => undefined;

describe('resolveUserHome on Windows', () => {
  test('prefers USERPROFILE, and never falls back to a bare root when HOME is unset', () => {
    const home = resolveUserHome({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\ada' },
      homedir: noHomedir,
    });

    expect(home).toBe('C:\\Users\\ada');

    // The regression itself: this join used to produce `/.diiisco`.
    expect(win32.join(home, '.diiisco')).toBe('C:\\Users\\ada\\.diiisco');
  });

  test('falls back to HOMEDRIVE + HOMEPATH when USERPROFILE is missing', () => {
    expect(
      resolveUserHome({
        platform: 'win32',
        env: { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\ada' },
        homedir: noHomedir,
      })
    ).toBe('C:\\Users\\ada');
  });

  test('ignores a Unix-shaped HOME in favour of USERPROFILE', () => {
    // Git Bash and MSYS set HOME to a path Windows APIs cannot use.
    expect(
      resolveUserHome({
        platform: 'win32',
        env: { HOME: '/c/Users/ada', USERPROFILE: 'C:\\Users\\ada' },
        homedir: noHomedir,
      })
    ).toBe('C:\\Users\\ada');
  });

  test('rejects a drive root rather than treating it as home', () => {
    expect(() =>
      resolveUserHome({ platform: 'win32', env: { USERPROFILE: 'C:\\' }, homedir: noHomedir })
    ).toThrow(HomeResolutionError);
  });

  test('rejects an empty environment instead of guessing', () => {
    // Previously this fell through to `process.cwd()`, which is how a stripped
    // environment silently manufactured a `.diiisco` wherever the daemon started.
    let thrown: unknown;
    try {
      resolveUserHome({ platform: 'win32', env: {}, homedir: noHomedir });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HomeResolutionError);
    expect((thrown as Error).message).toContain('DIIISCO_HOME');
  });
});

describe('resolveUserHome on Unix', () => {
  test('prefers os.homedir()', () => {
    expect(
      resolveUserHome({ platform: 'linux', env: { HOME: '/home/other' }, homedir: () => '/home/ada' })
    ).toBe('/home/ada');
  });

  test('falls back to HOME', () => {
    expect(resolveUserHome({ platform: 'linux', env: { HOME: '/home/ada' }, homedir: noHomedir })).toBe(
      '/home/ada'
    );
  });

  test('rejects `/`', () => {
    expect(() => resolveUserHome({ platform: 'linux', env: { HOME: '/' }, homedir: () => '/' })).toThrow(
      HomeResolutionError
    );
  });
});

describe('tilde expansion', () => {
  test('expands a leading ~ with either separator', () => {
    expect(expandTilde('~')).toBe(userHome());
    expect(expandTilde('~/.diiisco')).toBe(join(userHome(), '.diiisco'));
    expect(expandTilde('~\\.diiisco')).toBe(join(userHome(), '.diiisco'));
  });

  test('leaves a ~ that is not at the start alone', () => {
    expect(expandTilde('/srv/back~up')).toBe('/srv/back~up');
  });

  test('resolvePath always returns an absolute path', () => {
    expect(isAbsolute(resolvePath('~/.diiisco'))).toBe(true);
    expect(isAbsolute(resolvePath('relative/dir'))).toBe(true);
    expect(resolvePath('~/.diiisco')).toBe(join(userHome(), '.diiisco'));
  });
});

describe('peerIdStorage.path normalisation', () => {
  test('the committed default is already absolute', () => {
    // `src/dev.ts` and library consumers never run mergeConfig, so the default
    // itself has to be usable as-is.
    expect(isAbsolute(createDefaultEnvironment().peerIdStorage.path)).toBe(true);
  });

  test('a config that pins "~/.diiisco" is resolved, not passed through', () => {
    const home = mkdtempSync(join(tmpdir(), 'diiisco-paths-'));
    const previous = process.env.DIIISCO_HOME;
    process.env.DIIISCO_HOME = home;
    try {
      const env = mergeConfig({ peerIdStorage: { path: '~/.diiisco' } } as any);
      expect(env.peerIdStorage.path).toBe(join(userHome(), '.diiisco'));
      expect(env.peerIdStorage.path).not.toStartWith('/.diiisco');
    } finally {
      if (previous === undefined) delete process.env.DIIISCO_HOME;
      else process.env.DIIISCO_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a config with no peerIdStorage falls back to the DIIISCO home', () => {
    const home = mkdtempSync(join(tmpdir(), 'diiisco-paths-'));
    const previous = process.env.DIIISCO_HOME;
    process.env.DIIISCO_HOME = home;
    try {
      expect(mergeConfig({} as any).peerIdStorage.path).toBe(diiiscoHome());
    } finally {
      if (previous === undefined) delete process.env.DIIISCO_HOME;
      else process.env.DIIISCO_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
