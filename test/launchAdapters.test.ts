/**
 * Codex/Hermes model-wiring adapters against the compiled binary.
 *
 * Unlike `test/launch.test.ts`, these two write to `os.homedir()`-relative
 * paths (`~/.codex`, `~/.hermes`) — the third-party tools' own convention,
 * correctly independent of `DIIISCO_HOME`. That means the usual `DIIISCO_HOME`
 * override in `test/helpers.ts` does *not* isolate them: this suite also sets
 * `HOME` (and, on Windows, `USERPROFILE`) to a throwaway directory per test,
 * so `bun test` never touches a real developer's `~/.codex`/`~/.hermes`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { NO_BINARY_REASON, binary, freePort, makeHome, removeHome, runAsync } from './helpers';

const runnable = binary !== null && process.platform !== 'win32';
const suite = runnable ? describe : describe.skip;
if (!binary) console.warn(`skipping launchAdapters.test.ts: ${NO_BINARY_REASON}`);
else if (!runnable) console.warn('skipping launchAdapters.test.ts: the probe agent is a POSIX shell script');

suite('compiled binary — Codex/Hermes model-wiring adapters', () => {
  let home: string;
  let fakeHome: string;
  let probe: string;
  let probeOut: string;
  let server: ReturnType<typeof Bun.serve>;
  let endpoint: string;

  beforeAll(async () => {
    home = makeHome('diiisco-launch-adapters-');
    fakeHome = makeHome('diiisco-fake-home-');
    probe = join(home, 'probe-agent.sh');
    probeOut = join(home, 'probe-env.json');

    writeFileSync(
      probe,
      [
        '#!/bin/sh',
        'OUT="${DIIISCO_PROBE_OUT}"',
        'printf \'{"args": "%s"}\' "$*" > "$OUT"',
        'exit 0',
        '',
      ].join('\n'),
      'utf8'
    );
    chmodSync(probe, 0o700);

    writeFileSync(
      join(home, 'diiisco.config.json'),
      JSON.stringify(
        {
          models: { enabled: false, baseURL: 'http://localhost', port: 11434, apiKey: '' },
          api: { enabled: true, bearerAuthentication: false, keys: ['config-key'], port: 8_099 },
          libp2pBootstrapServers: [],
          local: { enabled: true, privateTopic: 'diiisco-test-launch-adapters/models/1.0.0' },
          cli: { apps: { codex: { bin: probe }, hermes: { bin: probe } } },
        },
        null,
        2
      ),
      { encoding: 'utf8', mode: 0o600 }
    );

    const port = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
    server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/health') return new Response('API is healthy');
        if (pathname === '/v1/models') {
          return Response.json({
            object: 'list',
            data: [{ id: 'diiisco-mesh-model-1', object: 'model', created: 0, owned_by: 'diiisco' }],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    removeHome(home);
    removeHome(fakeHome);
  });

  test('codex writes a dedicated profile + model catalog, never touching config.toml', async () => {
    rmSync(probeOut, { force: true });
    const result = await runAsync(['launch', '--endpoint', endpoint, '--key', 'test-key', 'codex'], {
      home,
      env: { DIIISCO_PROBE_OUT: probeOut, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    expect(result.code).toBe(0);

    const codexDir = join(fakeHome, '.codex');
    const profilePath = join(codexDir, 'diiisco-launch.config.toml');
    const catalogPath = join(codexDir, 'diiisco-launch.model.json');
    // The adapter never touches the user's own config.toml — only its own files.
    expect(existsSync(join(codexDir, 'config.toml'))).toBe(false);
    expect(existsSync(profilePath)).toBe(true);
    expect(existsSync(catalogPath)).toBe(true);

    const profile = parse(readFileSync(profilePath, 'utf8'));
    expect(profile.model).toBe('diiisco-mesh-model-1');
    expect(profile.model_provider).toBe('diiisco-launch');
    expect(profile.model_catalog_json).toBe(catalogPath);
    const providers = profile.model_providers as Record<string, Record<string, unknown>>;
    expect(providers['diiisco-launch'].base_url).toBe(`${endpoint}/v1/`);
    expect(providers['diiisco-launch'].wire_api).toBe('responses');

    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.models[0].slug).toBe('diiisco-mesh-model-1');

    const probeArgs = JSON.parse(readFileSync(probeOut, 'utf8')).args as string;
    expect(probeArgs).toBe('--profile diiisco-launch -m diiisco-mesh-model-1');
  });

  test('hermes merges a provider block into config.yaml, preserving the rest', async () => {
    const hermesDir = join(fakeHome, '.hermes');
    mkdirSync(hermesDir, { recursive: true });
    const configPath = join(hermesDir, 'config.yaml');
    const seeded = [
      '# a hand-written comment the merge must not lose',
      'providers:',
      '  openai:',
      '    api_key: sk-unrelated-and-must-survive',
      'unrelated_setting: keep-me',
      '',
    ].join('\n');
    writeFileSync(configPath, seeded, 'utf8');

    rmSync(probeOut, { force: true });
    const result = await runAsync(['launch', '--endpoint', endpoint, '--key', 'test-key', 'hermes'], {
      home,
      env: { DIIISCO_PROBE_OUT: probeOut, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    expect(result.code).toBe(0);

    const rewritten = readFileSync(configPath, 'utf8');
    // The comment and the unrelated provider/setting survive the merge.
    expect(rewritten).toContain('# a hand-written comment the merge must not lose');
    expect(rewritten).toContain('sk-unrelated-and-must-survive');
    expect(rewritten).toContain('keep-me');
    // A backup of the pre-merge file was made.
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(seeded);

    const parsed = parseYaml(rewritten) as any;
    expect(parsed.providers.diiisco.api).toBe(`${endpoint}/v1`);
    expect(parsed.providers.diiisco.api_key).toBe('test-key');
    expect(parsed.providers.diiisco.default_model).toBe('diiisco-mesh-model-1');
    expect(parsed.providers.openai.api_key).toBe('sk-unrelated-and-must-survive');
    expect(parsed.model.provider).toBe('custom:diiisco');
    expect(parsed.model.default).toBe('diiisco-mesh-model-1');
  });
});
