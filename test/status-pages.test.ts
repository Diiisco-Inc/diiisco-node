/**
 * The status pages, served **out of the compiled binary** (spec §6.1 "embedded
 * assets").
 *
 * The failure this suite exists to catch is subtle: Bun's standalone filesystem
 * has embedded files but no directories, so a build that embedded the assets
 * and kept `express.static(<dir>)` would happily serve `index.html` while every
 * hashed `<script>`/`<link>` it references 404s — a blank page, and worse than
 * the fallback shell. So it is not enough to assert the page loads: the assets
 * the page actually references are fetched, and their bytes compared with the
 * `dist/web` build they came from.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_BINARY_REASON,
  binary,
  forceStop,
  freePort,
  makeHome,
  removeHome,
  repoRoot,
  run,
  writeOfflineConfig,
} from './helpers';

const manifestPath = join(repoRoot, 'src', 'api', 'webManifest.generated.json');
const manifest: { files: Record<string, { contentType: string; bytes: number }> } = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { files: {} };
const embedded = Object.keys(manifest.files).length > 0;

const suite = binary && embedded ? describe : describe.skip;
if (!binary) console.warn(`skipping status-pages.test.ts: ${NO_BINARY_REASON}`);
else if (!embedded) console.warn('skipping status-pages.test.ts: the web manifest is empty — run `npm run build:web`');

suite('compiled binary — embedded status pages', () => {
  let home: string;
  let port: number;
  let base: string;
  let shell: string;

  beforeAll(async () => {
    home = makeHome('diiisco-web-');
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    writeOfflineConfig(home, port);
    expect(run(['start'], { home, timeoutMs: 60_000 }).code).toBe(0);
    shell = await (await fetch(`${base}/`)).text();
  });

  afterAll(() => {
    forceStop(home);
    removeHome(home);
  });

  test('the manifest, not a directory mount, is what the binary uses', () => {
    // The binary is not run from `dist/`, so there is no `web` directory beside
    // it — anything it serves came out of its own payload.
    const log = readFileSync(join(home, 'logs', 'diiisco.log'), 'utf8');
    expect(log).toContain('embedded');
    expect(log).not.toContain('serving the fallback shell');
  });

  test('/ serves the built shell, not the fallback paragraph', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");

    expect(shell).toContain('<title>DIIISCO Node</title>');
    // The fallback shell has no script tag; the real build always does.
    expect(shell).toContain('<script type="module"');
    expect(shell).not.toContain('The status page UI is not built');
  });

  test('every asset the shell references is served with the right type', async () => {
    const referenced = [...shell.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
    // A shell that references nothing would make this test vacuous.
    expect(referenced.length).toBeGreaterThan(0);

    for (const path of referenced) {
      const response = await fetch(`${base}${path}`);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 200`);

      const expectedType = path.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : path.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : response.headers.get('content-type');
      expect(response.headers.get('content-type')).toBe(expectedType);

      // Content-hashed filenames, so the year-long immutable cache is correct.
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

      const body = Buffer.from(await response.arrayBuffer());
      expect(body.length).toBeGreaterThan(0);
      expect(body.length).toBe(manifest.files[path].bytes);

      // Byte-identical to the vite output the manifest was generated from.
      const built = join(repoRoot, 'dist', 'web', path.slice(1));
      if (existsSync(built)) expect(body.equals(readFileSync(built))).toBe(true);
    }
  }, 60_000);

  test('a hashed asset revalidates with 304', async () => {
    const path = [...shell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])[0];
    expect(path).toBeDefined();

    const first = await fetch(`${base}${path}`);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const revalidated = await fetch(`${base}${path}`, { headers: { 'if-none-match': etag } });
    expect(revalidated.status).toBe(304);
  });

  test('the SPA routes resolve to the shell and their .json twins still work', async () => {
    const peerId = (await (await fetch(`${base}/node.json`)).json()).peerId as string;
    expect(peerId).toBeTruthy();

    for (const path of ['/nodes', `/nodes/${peerId}`]) {
      const response = await fetch(`${base}${path}`, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toBe(shell);
    }
  }, 30_000);

  test('the JSON routes are unchanged by the asset layer', async () => {
    for (const path of ['/node.json', '/nodes.json', '/models.json']) {
      const response = await fetch(`${base}${path}`);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 200`);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('public, max-age=30');
      await response.json();
    }
    expect((await fetch(`${base}/health`)).status).toBe(200);
  }, 30_000);

  test('unknown and traversal paths do not resolve to an asset', async () => {
    expect((await fetch(`${base}/assets/does-not-exist.js`)).status).toBe(404);
    expect((await fetch(`${base}/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
  });
});
