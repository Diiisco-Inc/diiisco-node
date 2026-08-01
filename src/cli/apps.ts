import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { Environment, CliAppConfig, CliWireProtocol } from '../environment/environment.types';

export interface LaunchTarget {
  app: string;
  bin: string;
  wire: CliWireProtocol;
  installHint: string;
  args: string[];
}

/** The `--list --json` row shape. This is a contract the desktop app consumes. */
export interface LaunchTargetListing {
  app: string;
  bin: string;
  wire: CliWireProtocol;
  installed: boolean;
  installHint: string;
}

/**
 * Built-in launch targets. Users extend or override this from config:
 *
 *   { "cli": { "apps": { "aider": { "bin": "aider", "wire": "openai" } } } }
 */
const BUILT_IN_APPS: Record<string, Omit<LaunchTarget, 'app'>> = {
  claude: {
    bin: 'claude',
    wire: 'anthropic',
    installHint: 'Install Claude Code: https://claude.com/claude-code',
    args: [],
  },
  openclaw: {
    bin: 'openclaw',
    wire: 'anthropic',
    installHint: 'Install openclaw and make sure `openclaw` is on your PATH.',
    args: [],
  },
  codex: {
    bin: 'codex',
    wire: 'openai',
    installHint: 'Install the Codex CLI: https://github.com/openai/codex',
    args: [],
  },
  opencode: {
    bin: 'opencode',
    wire: 'openai',
    installHint: 'Install opencode: https://opencode.ai',
    args: [],
  },
  hermes: {
    bin: 'hermes',
    wire: 'openai',
    installHint: 'Install hermes and make sure `hermes` is on your PATH.',
    args: [],
  },
};

function defaultInstallHint(bin: string): string {
  return `Install ${bin} and make sure \`${bin}\` is on your PATH.`;
}

/** The built-in map merged with any `cli.apps` from config (config wins). */
export function launchTargets(env?: Environment): Map<string, LaunchTarget> {
  const targets = new Map<string, LaunchTarget>();

  for (const [app, spec] of Object.entries(BUILT_IN_APPS)) {
    targets.set(app, { app, ...spec });
  }

  const custom = env?.cli?.apps;
  if (custom) {
    for (const [app, spec] of Object.entries(custom)) {
      const resolved = normaliseCustomApp(app, spec, targets.get(app));
      if (resolved) targets.set(app, resolved);
    }
  }

  return targets;
}

function normaliseCustomApp(
  app: string,
  spec: CliAppConfig | undefined,
  existing: LaunchTarget | undefined
): LaunchTarget | null {
  if (!spec || typeof spec !== 'object') return null;
  const bin = typeof spec.bin === 'string' && spec.bin.trim() !== '' ? spec.bin.trim() : existing?.bin ?? app;
  const wire: CliWireProtocol = spec.wire === 'anthropic' || spec.wire === 'openai' ? spec.wire : existing?.wire ?? 'openai';
  return {
    app,
    bin,
    wire,
    installHint: spec.installHint ?? existing?.installHint ?? defaultInstallHint(bin),
    args: Array.isArray(spec.args) ? spec.args.filter((a): a is string => typeof a === 'string') : existing?.args ?? [],
  };
}

export function listLaunchTargets(env?: Environment): LaunchTargetListing[] {
  return [...launchTargets(env).values()]
    .sort((a, b) => a.app.localeCompare(b.app))
    .map((target) => ({
      app: target.app,
      bin: target.bin,
      wire: target.wire,
      installed: which(target.bin) !== null,
      installHint: target.installHint,
    }));
}

/**
 * Resolve an executable on PATH, returning its absolute path or `null`.
 * On Windows every `PATHEXT` extension is tried, matching how the shell and
 * `child_process.spawn` resolve a bare command name.
 */
export function which(bin: string): string | null {
  if (bin === '') return null;

  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  const candidates: string[] = [];
  if (bin.includes('/') || (isWindows && bin.includes('\\'))) {
    candidates.push(isAbsolute(bin) ? bin : join(process.cwd(), bin));
  } else {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir === '') continue;
      candidates.push(join(dir.replace(/^"|"$/g, ''), bin));
    }
  }

  for (const candidate of candidates) {
    for (const ext of extensions) {
      const path = candidate + ext;
      if (isExecutableFile(path)) return path;
    }
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment variables that point an agent tool at a DIIISCO node.
 *
 * `ANTHROPIC_API_KEY` is blanked explicitly rather than left alone: a real key
 * already exported in the user's shell would otherwise take precedence over
 * `ANTHROPIC_AUTH_TOKEN` and quietly bill Anthropic instead of routing through
 * the node.
 */
export function launchEnv(wire: CliWireProtocol, endpoint: string, key: string, model?: string): Record<string, string> {
  const base = endpoint.replace(/\/$/, '');
  if (wire === 'anthropic') {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: '',
    };
    if (model) env.ANTHROPIC_MODEL = model;
    return env;
  }

  const env: Record<string, string> = {
    OPENAI_BASE_URL: `${base}/v1`,
    OPENAI_API_KEY: key,
  };
  if (model) env.OPENAI_MODEL = model;
  return env;
}
