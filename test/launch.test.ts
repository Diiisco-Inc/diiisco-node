/**
 * `launch` env-wiring against the compiled binary (spec §6.3 item 4).
 *
 * The launch contract is a set of environment variables, so the test is a fake
 * agent: a script registered through the config's `cli.apps` block that dumps
 * the variables it was handed. Two details are easy to get wrong and are
 * asserted explicitly:
 *
 *   • `ANTHROPIC_API_KEY` must be present *and empty*, not merely absent — a
 *     real key already exported in the user's shell would otherwise take
 *     precedence over `ANTHROPIC_AUTH_TOKEN` and bill Anthropic directly
 *     instead of routing through the node.
 *   • the OpenAI base URL carries the `/v1` suffix and the Anthropic one does
 *     not; the two adapters live at different paths.
 *
 * A stub `/health` server stands in for a node so `--endpoint` puts the CLI in
 * attach-only mode: no daemon is started, and the test needs no wallet, no
 * Ollama and no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_BINARY_REASON, binary, freePort, makeHome, removeHome, runAsync } from './helpers';

const runnable = binary !== null && process.platform !== 'win32';
const suite = runnable ? describe : describe.skip;
if (!binary) console.warn(`skipping launch.test.ts: ${NO_BINARY_REASON}`);
else if (!runnable) console.warn('skipping launch.test.ts: the probe agent is a POSIX shell script');

suite('compiled binary — launch env wiring', () => {
  let home: string;
  let probe: string;
  let probeOut: string;
  let server: ReturnType<typeof Bun.serve>;
  let endpoint: string;

  /** The variables the wire protocols are defined in terms of. */
  const WATCHED = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
  ];

  beforeAll(async () => {
    home = makeHome('diiisco-launch-');
    probe = join(home, 'probe-agent.sh');
    probeOut = join(home, 'probe-env.json');

    // `${VAR+set}` distinguishes "exported as empty" from "not exported at all",
    // which is the whole point of the ANTHROPIC_API_KEY assertion below.
    const lines = WATCHED.map(
      (name) => `  printf '  "%s": %s,\\n' '${name}' "$(if [ -n "\${${name}+set}" ]; then printf '"%s"' "$${name}"; else printf 'null'; fi)" >> "$OUT"`
    ).join('\n');

    writeFileSync(
      probe,
      [
        '#!/bin/sh',
        'OUT="${DIIISCO_PROBE_OUT}"',
        'printf \'{\\n\' > "$OUT"',
        lines,
        'printf \'  "args": "%s"\\n}\\n\' "$*" >> "$OUT"',
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
          local: { enabled: true, privateTopic: 'diiisco-test-launch/models/1.0.0' },
          cli: {
            apps: {
              'probe-anthropic': { bin: probe, wire: 'anthropic' },
              'probe-openai': { bin: probe, wire: 'openai' },
            },
          },
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
        return new Response('not found', { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    removeHome(home);
  });

  async function launch(args: string[]): Promise<Record<string, string | null>> {
    rmSync(probeOut, { force: true });
    // Async: the stub /health server below lives in this process, and spawnSync
    // would block the event loop that has to answer it.
    const result = await runAsync(args, {
      home,
      env: {
        DIIISCO_PROBE_OUT: probeOut,
        // A real key in the user's shell — the CLI must override it.
        ANTHROPIC_API_KEY: 'sk-ant-should-be-cleared',
        OPENAI_API_KEY: 'sk-openai-should-be-replaced',
      },
    });
    expect(result.code).toBe(0);
    expect(existsSync(probeOut)).toBe(true);
    return JSON.parse(readFileSync(probeOut, 'utf8'));
  }

  test('the anthropic wire points the agent at the node and blanks the real key', async () => {
    const env = await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', 'probe-anthropic']);

    expect(env.ANTHROPIC_BASE_URL).toBe(endpoint);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
    // Present, and empty — not inherited, not absent.
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_MODEL).toBeNull();
  });

  test('--model sets ANTHROPIC_MODEL', async () => {
    const env = await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', '--model', 'gpt-oss:20b', 'probe-anthropic']);
    expect(env.ANTHROPIC_MODEL).toBe('gpt-oss:20b');
  });

  test('the openai wire appends /v1 and replaces the inherited key', async () => {
    const env = await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', 'probe-openai']);

    expect(env.OPENAI_BASE_URL).toBe(`${endpoint}/v1`);
    expect(env.OPENAI_API_KEY).toBe('test-key');
    expect(env.OPENAI_API_KEY).not.toBe('sk-openai-should-be-replaced');
  });

  test('the key falls back to the configured api key', async () => {
    const env = await launch(['launch', '--endpoint', endpoint, 'probe-anthropic']);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('config-key');
  });

  test('positional arguments after the app name reach the agent untouched', async () => {
    const env = await launch(['launch', '--endpoint', endpoint, 'probe-anthropic', '--resume', 'session-7']);
    expect(env.args).toBe('--resume session-7');
  });

  test('an unreachable --endpoint fails instead of starting a local node', async () => {
    const dead = `http://127.0.0.1:${await freePort()}`;
    const result = await runAsync(['launch', '--endpoint', dead, 'probe-anthropic'], { home, env: { DIIISCO_PROBE_OUT: probeOut } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No DIIISCO node is answering');
  });

  test('an unknown app lists the supported ones', async () => {
    const result = await runAsync(['launch', '--endpoint', endpoint, 'not-an-agent'], { home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown app');
    expect(result.stderr).toContain('claude');
  });

  test('an app whose binary is missing gives an install hint, not an ENOENT', async () => {
    const result = await runAsync(['launch', '--endpoint', endpoint, 'codex'], { home });
    if (result.code === 0) return; // codex really is installed on this machine.
    expect(result.stderr).toContain('not on your PATH');
    expect(result.stderr).toContain('github.com/openai/codex');
  });
});
