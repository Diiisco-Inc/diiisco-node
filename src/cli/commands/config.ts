import { copyFileSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentFile } from '../../environment/environment.types';
import { validateEnvironment } from '../../environment/validate';
import {
  ConfigError,
  configLocation,
  configPath,
  loadConfig,
  mergeConfig,
  redactConfig,
  requireConfig,
  writeConfigFile,
} from '../config';
import { colour, die, info, json, print, setQuiet, success, warn } from '../output';

export interface ConfigOptions {
  subcommand: string | undefined;
  asJson: boolean;
}

export async function runConfig(options: ConfigOptions): Promise<void> {
  switch (options.subcommand) {
    case 'path':
      return runConfigPath();
    case 'show':
      return runConfigShow(options.asJson);
    case 'edit':
      return runConfigEdit();
    case undefined:
      die('Usage: diiisco config show|path|edit', 'Create a config with `diiisco setup`.');
      break;
    default:
      die(`Unknown config subcommand "${options.subcommand}".`, 'Usage: diiisco config show|path|edit');
  }
}

/** Prints the path whether or not the file exists — this must work unconfigured. */
function runConfigPath(): void {
  print(configPath());
}

function runConfigShow(asJson: boolean): void {
  if (asJson) setQuiet(true);
  const location = configLocation();
  const env = loadConfig();
  const redacted = redactConfig(env);

  if (asJson) {
    json(redacted);
    return;
  }

  info(colour.bold('Effective configuration'));
  info(colour.dim(location.exists ? `  defaults + ${location.path}` : '  defaults only — no config file'));
  info('');
  print(JSON.stringify(redacted, null, 2));

  if (!location.exists) {
    info('');
    warn(`No config file at ${configPath()} — run \`diiisco setup\` before starting the node.`);
    return;
  }

  const problems = validateEnvironment(env);
  if (problems.length > 0) {
    info('');
    warn('This configuration will not start:');
    for (const problem of problems) info(`  • ${problem}`);
  }
}

/**
 * Open the config in `$EDITOR` and install the result only if it parses and
 * validates. The original is never touched until the replacement is known good,
 * and a rejected draft is kept so the user does not lose their edits.
 */
async function runConfigEdit(): Promise<void> {
  requireConfig();
  const location = configLocation();
  const target = configPath();

  const editor = resolveEditor();
  const draft = join(tmpdir(), `diiisco-config-${process.pid}.json`);
  copyFileSync(location.path, draft);

  const before = readFileSync(draft, 'utf8');
  await runEditor(editor, draft);
  const after = readFileSync(draft, 'utf8');

  if (after === before) {
    unlinkSync(draft);
    info('No changes.');
    return;
  }

  let parsed: EnvironmentFile;
  try {
    const value = JSON.parse(after);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('top level value is not a JSON object');
    }
    parsed = value as EnvironmentFile;
  } catch (err: any) {
    rejectDraft(draft, `Not valid JSON: ${err?.message ?? err}`);
  }

  let problems: string[];
  try {
    problems = validateEnvironment(mergeConfig(parsed));
  } catch (err) {
    rejectDraft(draft, err instanceof ConfigError ? [err.message, ...err.hints].join(' ') : String(err));
  }

  if (problems.length > 0) rejectDraft(draft, ...problems);

  writeConfigFile(parsed, target);
  unlinkSync(draft);
  success(`Updated ${target}.`);
  if (location.legacy) {
    warn(`Your edits were written to ${target}; the deprecated ${location.path} is now unused and can be deleted.`);
  }
  info(colour.dim('  Restart the node to apply: diiisco restart'));
}

function rejectDraft(draft: string, ...problems: string[]): never {
  die(`Rejected the edit — ${configPath()} is unchanged.`, ...problems, `Your draft is kept at ${draft}`);
}

function resolveEditor(): string {
  const configured = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (configured) return configured;
  return process.platform === 'win32' ? 'notepad' : 'vi';
}

function runEditor(editor: string, path: string): Promise<void> {
  // `$EDITOR` is routinely a command line ("code --wait"), so split it.
  const [command, ...args] = editor.split(/\s+/);
  return new Promise((resolve) => {
    const child = spawn(command, [...args, path], { stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        die(`Could not run the editor "${command}".`, 'Set $EDITOR to something on your PATH.');
      }
      die(`Could not run the editor "${command}": ${err.message}`);
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        die(`The editor exited with status ${code} — ${configPath()} is unchanged.`);
      }
      resolve();
    });
  });
}
