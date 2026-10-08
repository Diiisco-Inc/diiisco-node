/**
 * The shared version source (`src/utils/version.ts`).
 *
 * The node profile used to read `package.json` itself, which a compiled binary
 * does not have, so a node running the binary published no version at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_VERSION, version } from '../src/utils/version';
import { version as cliVersion } from '../src/cli/version';
import { repoRoot } from './helpers';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const original = process.env.DIIISCO_VERSION;

afterEach(() => {
  if (original === undefined) delete process.env.DIIISCO_VERSION;
  else process.env.DIIISCO_VERSION = original;
});

describe('version()', () => {
  test('prefers the version baked in at build time', () => {
    process.env.DIIISCO_VERSION = '9.9.9';
    expect(version()).toBe('9.9.9');
  });

  test('reads package.json when nothing is baked in', () => {
    delete process.env.DIIISCO_VERSION;
    expect(version()).toBe(pkg.version);
  });

  test('the fallback constant has not drifted from package.json', () => {
    expect(FALLBACK_VERSION).toBe(pkg.version);
  });

  test('the CLI and the node profile share one source', () => {
    process.env.DIIISCO_VERSION = '1.2.3';
    expect(cliVersion()).toBe(version());
  });
});
