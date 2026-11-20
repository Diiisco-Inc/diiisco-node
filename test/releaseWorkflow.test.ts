/**
 * Supply-chain checks on the release pipeline (review L6): the workflow that
 * holds signing certificates runs only pinned third-party code, with the least
 * privilege each job needs, and the installers hold the desktop download to a
 * published checksum when there is one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers';

const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

describe('release workflow', () => {
  const workflow = read('.github/workflows/release.yml');
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];

  test('uses at least one action, and every one is pinned to a full commit SHA', () => {
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
    }
  });

  test('each pin records the tag it was taken from', () => {
    for (const [, , rest] of uses) expect(rest).toMatch(/#\s*v\d/);
  });

  test('the workflow is read-only by default and only the publishing job can write', () => {
    const top = workflow.split(/^jobs:/m)[0];
    expect(top).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(top).not.toMatch(/contents: write/);

    const release = workflow.slice(workflow.indexOf('\n  release:'));
    expect(release).toMatch(/permissions:\n\s+contents: write/);
    const beforeRelease = workflow.slice(0, workflow.indexOf('\n  release:'));
    expect(beforeRelease.split('jobs:')[1]).not.toMatch(/contents: write/);
  });
});

describe('installers verify the desktop download when a checksum is published', () => {
  test('install.sh checks <dmg>.sha256 and ignores a response that is not a digest', () => {
    const sh = read('install.sh');
    expect(sh).toContain('${DESKTOP_URL}.sha256');
    expect(sh).toContain('Checksum mismatch for ${DESKTOP_ARTIFACT}');
    expect(sh).toContain('No checksum is published for ${DESKTOP_ARTIFACT}');
    expect(sh).toContain('${#expected}" = 64');
  });

  test('install.ps1 does the same for the Windows installer', () => {
    const ps = read('install.ps1');
    expect(ps).toContain('"$desktopUrl.sha256"');
    expect(ps).toContain('[0-9a-fA-F]{64}');
    expect(ps).toContain('Checksum mismatch for $desktopArtifact');
    expect(ps).toContain('No checksum is published for $desktopArtifact');
  });
});
