import { spawn } from 'node:child_process';
import { LaunchTarget, launchEnv, launchTargets, listLaunchTargets, which } from '../apps';
import { Environment } from '../../environment/environment.types';
import { apiEndpoint, loadConfig, mergeConfig, requireConfig } from '../config';
import { probe } from '../daemon';
import { MODEL_WIRING, ModelWiringHook } from '../launchAdapters';
import { resolveLaunchModel } from '../modelResolution';
import { colour, die, info, json, setQuiet, warn } from '../output';
import { runStart } from './lifecycle';

const DEFAULT_KEY = 'diiisco';
const PROBE_TIMEOUT_MS = 2000;
const SPAWN_HEALTH_TIMEOUT_MS = 30_000;

export interface LaunchOptions {
  app?: string;
  passthrough: string[];
  endpoint?: string;
  /** `--remote` is an alias for `--endpoint`; either one implies attach-only. */
  explicitEndpoint: boolean;
  key?: string;
  model?: string;
  /** `--yes`/`-y`: never prompt for a model, take the deterministic default. */
  yes: boolean;
  noSpawn: boolean;
  list: boolean;
  asJson: boolean;
}

export async function runLaunch(options: LaunchOptions): Promise<void> {
  // `--list` and attach-only launches must work on an unconfigured machine, so
  // an absent (or broken) config degrades to the defaults here; the config gate
  // is applied further down, only on the path that would start a local node.
  let env: Environment;
  try {
    env = loadConfig();
  } catch (err) {
    if (options.list) env = mergeConfig(null);
    else throw err;
  }

  if (options.list) {
    const listing = listLaunchTargets(env);
    if (options.asJson) {
      setQuiet(true);
      json(listing);
      return;
    }
    info(colour.bold('Launch targets'));
    info('');
    const width = Math.max(...listing.map((t) => t.app.length), 4);
    for (const target of listing) {
      const state = target.installed ? colour.green('installed') : colour.dim('not installed');
      const wiring = target.defaultModelWiring ? colour.dim(' · wires a default model') : '';
      info(`  ${target.app.padEnd(width)}  ${target.wire.padEnd(9)}  ${state}${wiring}`);
      if (!target.installed) info(`  ${' '.repeat(width)}  ${colour.dim(target.installHint)}`);
    }
    info('');
    info(colour.dim('  Add your own with the `cli.apps` block in `diiisco config edit`.'));
    return;
  }

  if (!options.app) {
    die('Which app? e.g. `diiisco launch claude`.', 'See the full list with `diiisco launch --list`.');
  }

  const targets = launchTargets(env);
  const target = targets.get(options.app);
  if (!target) {
    die(
      `Unknown app "${options.app}".`,
      `Supported: ${[...targets.keys()].sort().join(', ')}`,
      'Add your own with the `cli.apps` block in `diiisco config edit`.'
    );
  }

  // 1. Resolve endpoint and key. The default comes from the configured
  // `api.port`, not a hardcoded 8080 — otherwise a node on a custom port sends
  // the agent tool to an address nothing is listening on.
  const endpoint = (options.endpoint ?? process.env.DIIISCO_ENDPOINT ?? apiEndpoint(env)).replace(/\/$/, '');
  const key = options.key ?? process.env.DIIISCO_API_KEY ?? env.api.keys?.[0] ?? DEFAULT_KEY;
  // An explicit endpoint (or --no-spawn) means "attach to that node" — never
  // silently start a local one that is not the node the user asked for.
  const attachOnly = options.explicitEndpoint || options.noSpawn;

  // 2. Probe.
  const reachable = (await probe(endpoint, '/health', PROBE_TIMEOUT_MS)).ok;

  // 3. Start a local node if we are allowed to.
  if (!reachable) {
    if (attachOnly) {
      die(
        `No DIIISCO node is answering at ${endpoint}.`,
        options.explicitEndpoint
          ? 'Check the address, or drop --endpoint/--remote to start a local node.'
          : 'Drop --no-spawn to start a local node automatically, or run `diiisco start` yourself.'
      );
    }

    // Only now do we need a configured node — attaching to a remote one above
    // never touches local config.
    requireConfig();

    info(`No node at ${endpoint} — starting one…`);
    await runStart({ timeoutMs: SPAWN_HEALTH_TIMEOUT_MS, silent: true });

    const started = (await probe(endpoint, '/health', PROBE_TIMEOUT_MS)).ok;
    if (!started) {
      die(
        `Started a node but ${endpoint} is still not answering.`,
        'Check the log: diiisco logs -n 50'
      );
    }
    info(colour.dim(`  node ready on ${endpoint}`));
  }

  // 4. Resolve a model, for tools that have a model-wiring hook (or when the
  // user asked for one explicitly regardless). Apps with neither keep
  // today's behavior exactly — no network call, no prompt.
  const hook = MODEL_WIRING[target.app];
  const model = hook || options.model
    ? await resolveLaunchModel(endpoint, key, options.model, env.quoteEngine?.waitTime ?? 5000, options.yes)
    : undefined;

  // 5. Wire the env and hand over.
  await spawnApp(target, endpoint, key, model, options.passthrough, hook);
}

async function spawnApp(
  target: LaunchTarget,
  endpoint: string,
  key: string,
  model: string | undefined,
  passthrough: string[],
  hook?: ModelWiringHook
): Promise<void> {
  if (which(target.bin) === null) {
    die(`\`${target.bin}\` is not on your PATH.`, target.installHint);
  }

  // A hook owns all model-related env/args for its app — set the generic
  // ANTHROPIC_MODEL/OPENAI_MODEL only when there's no hook to conflict with.
  const wireEnv = launchEnv(target.wire, endpoint, key, hook ? undefined : model);
  let extraArgs: string[] = [];
  if (hook && model) {
    const result = await hook({ model, endpoint, key, target });
    Object.assign(wireEnv, result.env);
    extraArgs = result.args ?? [];
  }

  info(colour.dim(`  ${target.app} → ${endpoint} (${target.wire})`));

  const child = spawn(target.bin, [...extraArgs, ...target.args, ...passthrough], {
    stdio: 'inherit',
    env: { ...process.env, ...wireEnv },
  });

  await new Promise<void>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        die(`\`${target.bin}\` is not on your PATH.`, target.installHint);
      }
      die(`Could not start ${target.bin}: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        warn(`${target.bin} exited on ${signal}.`);
        process.exitCode = 1;
      } else {
        process.exitCode = code ?? 0;
      }
      resolve();
    });
  });
}
