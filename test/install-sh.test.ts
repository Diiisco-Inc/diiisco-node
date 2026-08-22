/**
 * Static checks on `install.sh` (spec §7.1).
 *
 * The installer is the first thing a new user runs and the one piece of this
 * repo that cannot be exercised by `bun test` end-to-end — it downloads a
 * published release. What *can* be checked cheaply is that it parses as POSIX
 * sh, passes shellcheck, and still states the contracts the spec pins down:
 * checksum verification, no implicit sudo, and the two-command next-steps text.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers';

const script = join(repoRoot, 'install.sh');
const suite = existsSync(script) ? describe : describe.skip;

suite('install.sh', () => {
  const source = existsSync(script) ? readFileSync(script, 'utf8') : '';

  test('is valid POSIX sh', () => {
    const result = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('passes shellcheck', () => {
    const available = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0;
    if (!available) {
      console.warn('skipping the shellcheck run: shellcheck is not installed');
      return;
    }
    const result = spawnSync('shellcheck', ['-s', 'sh', script], { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  test('--help works without reading its own file (curl | sh has none)', () => {
    const result = spawnSync('sh', [script, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--install-dir');
    expect(result.stdout).toContain('--modify-path');
    expect(result.stdout).toContain('--system');
    expect(result.stdout).toContain('--version');
  });

  test('rejects an unknown flag rather than ignoring it', () => {
    const result = spawnSync('sh', [script, '--not-a-flag'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option');
  });

  test('verifies the download and never runs sudo itself', () => {
    expect(source).toContain('SHA256SUMS');
    expect(source).toContain('Checksum mismatch');
    // Every mention of sudo must be inside a message telling the user what to
    // run — the script itself must never invoke it.
    for (const line of source.split('\n')) {
      if (!line.includes('sudo')) continue;
      const isText = /^\s*(#|die |warn |say |info |.*")/.test(line);
      expect(isText).toBe(true);
    }
  });

  test('points at the two-command onboarding, not a zero-config run', () => {
    // §3.3: a config file is required, so "install then run" would be wrong.
    expect(source).toContain('diiisco setup');
    expect(source).toContain('diiisco launch claude');
  });

  test('knows every Unix target the compile matrix produces', () => {
    for (const target of ['darwin', 'linux', 'arm64', 'x64']) {
      expect(source).toContain(target);
    }
    expect(source).toContain('diiisco-${TARGET}');
  });
});
