/**
 * `scripts/check-deps.mjs` is the guard behind principle 1 in CLAUDE.md: the
 * repo itself must pass it, and it must fail on the two kinds of drift it names.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers';

const run = (cwd: string) => spawnSync('node', [join(cwd, 'scripts', 'check-deps.mjs')], { cwd, encoding: 'utf8' });

describe('check-deps', () => {
  test('this repository has no unused or undeclared dependencies', () => {
    const result = run(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  describe('on a project with drift', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'diiisco-deps-'));
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'src'));
      cpSync(join(repoRoot, 'scripts', 'check-deps.mjs'), join(dir, 'scripts', 'check-deps.mjs'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'x', type: 'module', dependencies: { 'used-pkg': '1', '@scope/used': '1', 'unused-pkg': '1' }, devDependencies: { 'dev-pkg': '1' },
      }));
      writeFileSync(join(dir, 'src', 'a.ts'), [
        `import a from 'used-pkg/sub/path';`,
        `import { b } from "@scope/used/deep";`,
        `import fs from 'node:fs';`,
        `import path from 'path';`,
        `import local from './local';`,
        `const lazy = await import('undeclared-pkg');`,
        "console.log(`from \"${'not a module'}\"`);",
      ].join('\n'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test('names the unused and the undeclared package, and only those', () => {
      const result = run(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unused dependency: "unused-pkg"');
      expect(result.stderr).toContain('undeclared dependency: "undeclared-pkg"');
      expect(result.stderr).not.toContain('"used-pkg"');
      expect(result.stderr).not.toContain('@scope/used');
      expect(result.stderr).not.toContain('node:fs');
      expect(result.stderr).toContain('2 problem(s)');
    });
  });
});
