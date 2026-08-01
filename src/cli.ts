/**
 * `diiisco` — the DIIISCO CLI entry point.
 *
 * Thin by design: parse argv, dispatch into `src/cli/`, and turn anything
 * thrown into an actionable one-liner rather than a stack trace. The node
 * itself is embedded (`src/index.ts`'s `Application`), so `serve` runs it in
 * process and `start` re-spawns this same executable detached — no npm, no PM2,
 * no system Node required.
 */
import { flagBoolean, flagNumber, flagString, parseArgs } from './cli/args';
import { ConfigError } from './cli/config';
import { DAEMON_ARG } from './cli/daemon';
import { colour, die, error, info, print, setQuiet } from './cli/output';
import { versionLine } from './cli/version';
import { runHelp } from './cli/commands/help';
import { runLaunch } from './cli/commands/launch';
import { runLogs } from './cli/commands/logs';
import { runRestart, runStart, runStatus, runStop } from './cli/commands/lifecycle';
import { runServe } from './cli/commands/serve';
import { runConfig, ConfigMode } from './cli/commands/config';

const DEFAULT_LOG_LINES = 100;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    // Internal: `start` re-spawns the executable with this argument. Not
    // documented in `help` because users never type it.
    case DAEMON_ARG:
      return runServe({ daemon: true });

    case 'serve':
      return runServe();

    case 'start':
      await runStart();
      return;

    case 'stop':
      return runStop();

    case 'restart':
      return runRestart();

    case 'status': {
      const parsed = parseArgs(rest);
      return runStatus(flagBoolean(parsed, 'json'));
    }

    case 'logs': {
      const parsed = parseArgs(rest, { valueFlags: ['n', 'lines'] });
      const lines = flagNumber(parsed, 'n', 'lines') ?? DEFAULT_LOG_LINES;
      return runLogs(Math.max(0, Math.floor(lines)), flagBoolean(parsed, 'f', 'follow'));
    }

    case 'launch': {
      // Stop at the first positional so everything after the app name goes to
      // the child untouched (`diiisco launch claude --resume`).
      const parsed = parseArgs(rest, {
        valueFlags: ['endpoint', 'remote', 'key', 'model'],
        stopAfterPositionals: 1,
      });
      const endpoint = flagString(parsed, 'endpoint') ?? flagString(parsed, 'remote');
      return runLaunch({
        app: parsed.positionals[0],
        passthrough: parsed.rest,
        endpoint,
        explicitEndpoint: endpoint !== undefined,
        key: flagString(parsed, 'key'),
        model: flagString(parsed, 'model'),
        noSpawn: flagBoolean(parsed, 'no-spawn'),
        list: flagBoolean(parsed, 'list'),
        asJson: flagBoolean(parsed, 'json'),
      });
    }

    case 'config': {
      const parsed = parseArgs(rest);
      const local = flagBoolean(parsed, 'local');
      const isPublic = flagBoolean(parsed, 'public');
      if (local && isPublic) die('Pick one: --local or --public.');
      const mode: ConfigMode | undefined = local ? 'local' : isPublic ? 'public' : undefined;
      return runConfig({
        subcommand: parsed.positionals[0],
        mode,
        asJson: flagBoolean(parsed, 'json'),
        force: flagBoolean(parsed, 'force'),
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
