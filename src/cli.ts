/**
 * `diiisco` — the DIIISCO CLI entry point.
 *
 * Thin by design: parse argv, dispatch into `src/cli/`, and turn anything
 * thrown into an actionable one-liner rather than a stack trace. The node
 * itself is embedded (`src/index.ts`'s `Application`), so `serve` runs it in
 * process and `start` re-spawns this same executable detached — no npm, no PM2,
 * no system Node required.
 */
import { flagBoolean, flagNumber, flagString, parseArgs, ParsedArgs } from './cli/args';
import { ConfigError, setConfigPathOverride } from './cli/config';
import { DAEMON_ARG } from './cli/daemon';
import { colour, die, error, info, print, setQuiet } from './cli/output';
import { versionLine } from './cli/version';
import { runHelp } from './cli/commands/help';
import { runLaunch } from './cli/commands/launch';
import { runLogs } from './cli/commands/logs';
import { runRestart, runStart, runStatus, runStop } from './cli/commands/lifecycle';
import { runServe } from './cli/commands/serve';
import { runConfig } from './cli/commands/config';
import { runSetup, SetupMode } from './cli/commands/setup';

const DEFAULT_LOG_LINES = 100;

/** `--config <path>` is global: it applies to whichever command follows it. */
function applyConfigOverride(parsed: ParsedArgs): void {
  const path = flagString(parsed, 'config');
  if (path !== undefined) setConfigPathOverride(path);
}

/** Shared parse for `setup` and its deprecated `config init` alias. */
function setupOptions(rest: string[], deprecatedAlias: boolean) {
  const parsed = parseArgs(rest, {
    valueFlags: ['network', 'api-port', 'models-url', 'max-spend', 'config'],
  });
  applyConfigOverride(parsed);

  const local = flagBoolean(parsed, 'local');
  const isPublic = flagBoolean(parsed, 'public');
  if (local && isPublic) die('Pick one: --local or --public.');
  const mode: SetupMode | undefined = local ? 'local' : isPublic ? 'public' : undefined;

  return {
    mode,
    yes: flagBoolean(parsed, 'yes', 'y'),
    force: flagBoolean(parsed, 'force'),
    print: flagBoolean(parsed, 'print'),
    network: flagString(parsed, 'network'),
    apiPort: flagNumber(parsed, 'api-port'),
    modelsUrl: flagString(parsed, 'models-url'),
    maxSpend: flagNumber(parsed, 'max-spend'),
    mnemonicStdin: flagBoolean(parsed, 'mnemonic-stdin'),
    deprecatedAlias,
  };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    // Internal: `start` re-spawns the executable with this argument. Not
    // documented in `help` because users never type it.
    case DAEMON_ARG: {
      applyConfigOverride(parseArgs(rest, { valueFlags: ['config'] }));
      return runServe({ daemon: true });
    }

    case 'serve': {
      applyConfigOverride(parseArgs(rest, { valueFlags: ['config'] }));
      return runServe();
    }

    case 'start': {
      applyConfigOverride(parseArgs(rest, { valueFlags: ['config'] }));
      await runStart();
      return;
    }

    case 'stop':
      return runStop();

    case 'restart': {
      applyConfigOverride(parseArgs(rest, { valueFlags: ['config'] }));
      return runRestart();
    }

    case 'status': {
      const parsed = parseArgs(rest, { valueFlags: ['config'] });
      applyConfigOverride(parsed);
      return runStatus(flagBoolean(parsed, 'json'));
    }

    case 'setup':
      return runSetup(setupOptions(rest, false));

    case 'logs': {
      const parsed = parseArgs(rest, { valueFlags: ['n', 'lines'] });
      const lines = flagNumber(parsed, 'n', 'lines') ?? DEFAULT_LOG_LINES;
      return runLogs(Math.max(0, Math.floor(lines)), flagBoolean(parsed, 'f', 'follow'));
    }

    case 'launch': {
      // Stop at the first positional so everything after the app name goes to
      // the child untouched (`diiisco launch claude --resume`).
      const parsed = parseArgs(rest, {
        valueFlags: ['endpoint', 'remote', 'key', 'model', 'config'],
        stopAfterPositionals: 1,
      });
      applyConfigOverride(parsed);
      const endpoint = flagString(parsed, 'endpoint') ?? flagString(parsed, 'remote');
      return runLaunch({
        app: parsed.positionals[0],
        passthrough: parsed.rest,
        endpoint,
        explicitEndpoint: endpoint !== undefined,
        key: flagString(parsed, 'key'),
        model: flagString(parsed, 'model'),
        yes: flagBoolean(parsed, 'yes', 'y'),
        noSpawn: flagBoolean(parsed, 'no-spawn'),
        list: flagBoolean(parsed, 'list'),
        asJson: flagBoolean(parsed, 'json'),
      });
    }

    case 'config': {
      // `config init` is a hidden, deprecated alias for `setup`.
      if (rest[0] === 'init') return runSetup(setupOptions(rest.slice(1), true));

      const parsed = parseArgs(rest, { valueFlags: ['config'] });
      applyConfigOverride(parsed);
      return runConfig({
        subcommand: parsed.positionals[0],
        asJson: flagBoolean(parsed, 'json'),
        key: flagBoolean(parsed, 'key'),
      });
    }

    case 'version':
    case '--version':
    case '-v':
      print(versionLine());
      return;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      runHelp();
      return;

    default:
      die(`Unknown command "${command}".`, 'Run `diiisco help` to see the available commands.');
  }
}

// `--json` consumers get JSON on stdout and nothing else, so suppress the
// human-facing chatter before any command runs.
if (process.argv.includes('--json')) setQuiet(true);

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    error(err.message);
    for (const hint of err.hints) process.stderr.write(`  ${colour.dim(hint)}\n`);
    process.exit(1);
  }

  const message = err instanceof Error ? err.message : String(err);
  error(message);
  if (process.env.DIIISCO_DEBUG === '1' && err instanceof Error && err.stack) {
    process.stderr.write(`${colour.dim(err.stack)}\n`);
  } else {
    info(colour.dim('  Re-run with DIIISCO_DEBUG=1 for the full stack trace.'));
  }
  process.exit(1);
});
