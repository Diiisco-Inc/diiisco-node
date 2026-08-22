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
  let probeCalls: string;
  let server: ReturnType<typeof Bun.serve>;
  let endpoint: string;

  /** The variables the wire protocols are defined in terms of. */
  const WATCHED = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENCODE_CONFIG_CONTENT',
  ];

  /** Model ids the stub `/v1/models` route hands back; overwritten per-test. */
  let meshModels: string[] = ['diiisco-mesh-model-1'];
  let lastModelsAuthHeader: string | null = null;

  beforeAll(async () => {
    home = makeHome('diiisco-launch-');
    probe = join(home, 'probe-agent.sh');
    probeOut = join(home, 'probe-env.json');
    probeCalls = join(home, 'probe-calls.log');

    // `${VAR+set}` distinguishes "exported as empty" from "not exported at all",
    // which is the whole point of the ANTHROPIC_API_KEY assertion below. Values
    // are base64-encoded before landing in probeOut's JSON — OPENCODE_CONFIG_CONTENT
    // is itself JSON, and naively quoting it would corrupt probeOut's own JSON.
    // `launch()` below decodes every field back before returning it to a test.
    const lines = WATCHED.map(
      (name) =>
        `  if [ -n "\${${name}+set}" ]; then printf '  "%s": "%s",\\n' '${name}' "$(printf '%s' "$${name}" | base64 | tr -d '\\n')" >> "$OUT"; else printf '  "%s": null,\\n' '${name}' >> "$OUT"; fi`
    ).join('\n');

    writeFileSync(
      probe,
      [
        '#!/bin/sh',
        'OUT="${DIIISCO_PROBE_OUT}"',
        'printf \'{\\n\' > "$OUT"',
        lines,
        'printf \'  "args": "%s"\\n}\\n\' "$(printf \'%s\' "$*" | base64 | tr -d \'\\n\')" >> "$OUT"',
        // A separate, append-only call log — OpenClaw's hook invokes this
        // probe binary twice (a one-shot `onboard` subprocess, then the real
        // spawn), and probeOut above only ever holds the latest invocation.
        // Records argv and CUSTOM_API_KEY (the onboarding secret) per call.
        'if [ -n "${DIIISCO_PROBE_CALLS+set}" ]; then',
        '  printf \'%s\\t%s\\n\' "$*" "$(printf \'%s\' "$CUSTOM_API_KEY" | base64 | tr -d \'\\n\')" >> "$DIIISCO_PROBE_CALLS"',
        'fi',
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
              // The built-in apps below keep their wire/hook; only `bin` is
              // swapped so the real model-wiring hooks still fire against
              // this fake binary instead of the real tools.
              claude: { bin: probe },
              opencode: { bin: probe },
              openclaw: { bin: probe },
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
        if (pathname === '/v1/models') {
          lastModelsAuthHeader = request.headers.get('authorization');
          return Response.json({
            object: 'list',
            data: meshModels.map((id) => ({ id, object: 'model', created: 0, owned_by: 'diiisco' })),
          });
        }
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
    rmSync(probeCalls, { force: true });
    // Async: the stub /health server below lives in this process, and spawnSync
    // would block the event loop that has to answer it.
    const result = await runAsync(args, {
      home,
      env: {
        DIIISCO_PROBE_OUT: probeOut,
        DIIISCO_PROBE_CALLS: probeCalls,
        // A real key in the user's shell — the CLI must override it.
        ANTHROPIC_API_KEY: 'sk-ant-should-be-cleared',
        OPENAI_API_KEY: 'sk-openai-should-be-replaced',
      },
    });
    expect(result.code).toBe(0);
    expect(existsSync(probeOut)).toBe(true);
    const raw = JSON.parse(readFileSync(probeOut, 'utf8')) as Record<string, string | null>;
    const decoded: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(raw)) {
      decoded[key] = value === null ? null : Buffer.from(value, 'base64').toString('utf8');
    }
    return decoded;
  }

  /** Every invocation of the probe binary during the last `launch()` call. */
  function readProbeCalls(): Array<{ args: string; customApiKey: string }> {
    if (!existsSync(probeCalls)) return [];
    return readFileSync(probeCalls, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [args, key] = line.split('\t');
        return { args, customApiKey: Buffer.from(key ?? '', 'base64').toString('utf8') };
      });
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

  test('claude wires a single mesh model into all tiers, not the generic var', async () => {
    meshModels = ['diiisco-mesh-model-1'];
    const env = await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', 'claude']);

    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('diiisco-mesh-model-1');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('diiisco-mesh-model-1');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('diiisco-mesh-model-1');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('diiisco-mesh-model-1');
    // The hook owns the model signal exclusively — no redundant/conflicting var.
    expect(env.ANTHROPIC_MODEL).toBeNull();
    expect(lastModelsAuthHeader).toBe('Bearer test-key');
  });

  test('claude --model skips mesh discovery entirely', async () => {
    meshModels = ['should-not-be-picked'];
    lastModelsAuthHeader = null;
    const env = await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', '--model', 'explicit-model', 'claude']);

    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('explicit-model');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('explicit-model');
    expect(lastModelsAuthHeader).toBeNull();
  });

  test('claude with no mesh models falls back to unwired launch', async () => {
    meshModels = [];
    const env = await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', 'claude']);

    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeNull();
    expect(env.ANTHROPIC_BASE_URL).toBe(endpoint);
    meshModels = ['diiisco-mesh-model-1'];
  });

  test('opencode wires a provider block via OPENCODE_CONFIG_CONTENT', async () => {
    meshModels = ['diiisco-mesh-model-1'];
    const env = await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', 'opencode']);

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
    expect(config.provider.diiisco.options.baseURL).toBe(`${endpoint}/v1`);
    expect(config.provider.diiisco.options.apiKey).toBe('test-key');
    expect(config.provider.diiisco.models).toHaveProperty('diiisco-mesh-model-1');
    // No file writes for OpenCode — the generic OPENAI_MODEL stays unset too,
    // same "hook owns the model signal" rule as Claude Code.
    expect(env.OPENAI_MODEL).toBeNull();
  });

  test('openclaw onboards non-interactively before the real spawn, then launches clean', async () => {
    meshModels = ['diiisco-mesh-model-1'];
    await launch(['launch', '--endpoint', endpoint, '--key', 'test-key', 'openclaw']);

    const calls = readProbeCalls();
    expect(calls.length).toBe(2);

    const [onboard, realSpawn] = calls;
    expect(onboard.args).toBe(
      `onboard --non-interactive --accept-risk --auth-choice custom-api-key --custom-compatibility openai --custom-provider-id diiisco --custom-base-url ${endpoint} --custom-model-id diiisco-mesh-model-1`
    );
    // The key travels via env, not argv (ps visibility) — same convention as
    // ANTHROPIC_AUTH_TOKEN elsewhere in this codebase.
    expect(onboard.customApiKey).toBe('test-key');

    // The real spawn carries no onboarding args and no leaked secret env var.
    expect(realSpawn.args).toBe('');
    expect(realSpawn.customApiKey).toBe('');
  });

  test('an app whose binary is missing gives an install hint, not an ENOENT', async () => {
    const result = await runAsync(['launch', '--endpoint', endpoint, 'codex'], { home });
    if (result.code === 0) return; // codex really is installed on this machine.
    expect(result.stderr).toContain('not on your PATH');
    expect(result.stderr).toContain('github.com/openai/codex');
  });
});
