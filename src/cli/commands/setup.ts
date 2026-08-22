import { existsSync } from 'node:fs';
import algosdk from 'algosdk';
import { EnvironmentFile } from '../../environment/environment.types';
import { validateEnvironment } from '../../environment/validate';
import {
  ConfigError,
  configPath,
  generateApiKey,
  generatePrivateTopic,
  mergeConfig,
  readConfigFile,
  readKeyFile,
  redactConfig,
  serializeConfig,
  withoutMnemonic,
  writeConfigFile,
  writeKeyFile,
} from '../config';
import { assertMnemonic as assertUsableMnemonic, sameWallet } from '../keystore';
import { Prompter, readStdin } from '../prompt';
import { colour, die, info, print, setQuiet, success, warn } from '../output';

export type SetupMode = 'local' | 'public';

export interface SetupOptions {
  mode?: SetupMode;
  yes: boolean;
  force: boolean;
  print: boolean;
  network?: string;
  apiPort?: number;
  modelsUrl?: string;
  maxSpend?: number;
  mnemonicStdin: boolean;
  /** True when invoked through the deprecated `config init` alias. */
  deprecatedAlias?: boolean;
}

const DEFAULT_MODELS_URL = 'http://localhost:11434';

export async function runSetup(options: SetupOptions): Promise<void> {
  if (options.deprecatedAlias) {
    warn('`diiisco config init` is deprecated — use `diiisco setup`.');
  }
  if (options.print) setQuiet(true);

  const path = configPath();
  const existing = readExistingConfig(path, options.force);
  const editing = existing !== null;

  // In `--print` mode stdout carries the JSON, so every prompt and note has to
  // go to stderr or the output stops being pipeable.
  const out = options.print ? process.stderr : process.stdout;
  const prompt = new Prompter(out, options.yes);

  try {
    const mnemonicFromStdin = options.mnemonicStdin ? (await readStdin()).trim() : null;

    if (!options.print) {
      info('');
      info(colour.bold(editing ? 'Editing your DIIISCO configuration' : 'Setting up DIIISCO'));
      info(colour.dim(`  ${path}`));
      info('');
    }

    const config = await buildConfig(prompt, options, existing ?? {}, mnemonicFromStdin);

    // Refuse to write something the node would only reject at start-up.
    const problems = validateEnvironment(mergeConfig(config));
    if (problems.length > 0) {
      throw new ConfigError('That configuration would not start:', problems);
    }

    const mnemonic = config.algorand?.mnemonic;

    if (options.print) {
      // `--print` writes nothing, so it must not emit a spending key either:
      // what goes to stdout is the config file, and the config file no longer
      // holds a wallet.
      if (mnemonic !== undefined && !isStoredKey(mnemonic)) {
        die(
          '`--print` writes nothing, so it cannot store a wallet key.',
          'Re-run without --print to set the wallet up properly.'
        );
      }
      print(serializeConfig(withoutMnemonic(config)));
      return;
    }

    // The wallet key is written first: if this run dies between the two writes,
    // the key still exists on disk rather than only in the user's terminal.
    if (mnemonic !== undefined) {
      const keyFile = writeKeyFile(mnemonic);
      success(`Wrote ${keyFile} (mode 0600) — this file is your wallet.`);
    }

    writeConfigFile(withoutMnemonic(config), path);
    success(`Wrote ${path} (mode 0600).`);
    info('');
    info(colour.bold('Summary'));
    print(JSON.stringify(redactConfig(config), null, 2));
    info('');
    info(`Next: ${colour.cyan('diiisco start')}, then ${colour.cyan('diiisco launch claude')}.`);
  } finally {
    prompt.close();
  }
}

/** True when this mnemonic is already the one in `algorand-key.json`. */
function isStoredKey(mnemonic: string): boolean {
  const stored = readKeyFile();
  return stored !== null && sameWallet(stored.mnemonic, mnemonic);
}

function readExistingConfig(path: string, force: boolean): EnvironmentFile | null {
  if (!existsSync(path)) return null;
  try {
    return readConfigFile();
  } catch (err) {
    // A file we cannot parse is never silently clobbered — the user may have a
    // wallet mnemonic in there behind a stray comma.
    if (force) {
      warn(`Ignoring the unparseable ${path} because --force was given; it will be overwritten.`);
      return null;
    }
    const hints = err instanceof ConfigError ? err.hints : [];
    throw new ConfigError(
      `${path} exists but cannot be parsed, so setup will not overwrite it.`,
      [...hints, 'Fix it by hand, or re-run with --force to replace it.']
    );
  }
}

async function buildConfig(
  prompt: Prompter,
  options: SetupOptions,
  existing: EnvironmentFile,
  mnemonicFromStdin: string | null
): Promise<EnvironmentFile> {
  const config: EnvironmentFile = { ...existing };

  // 1. Mode.
  const currentMode: SetupMode = existing.local?.enabled === true ? 'local' : existing.algorand ? 'public' : 'local';
  const mode = options.mode ?? (await prompt.choose('Mode — local is payment-free, public settles in USDC', ['local', 'public'] as const, currentMode));

  // 2. Inference backend.
  const currentModelsUrl = existing.models?.baseURL
    ? `${existing.models.baseURL}${existing.models.port ? `:${existing.models.port}` : ''}`
    : DEFAULT_MODELS_URL;
  const modelsUrl = options.modelsUrl ?? (await prompt.ask('Inference backend URL', currentModelsUrl));
  const { baseURL, port: modelsPort } = splitModelsUrl(modelsUrl);
  await reportBackend(prompt, options, baseURL, modelsPort);

  config.models = {
    enabled: true,
    baseURL,
    port: modelsPort,
    apiKey: existing.models?.apiKey ?? '',
    ...(existing.models?.chargePer1MTokens ? { chargePer1MTokens: existing.models.chargePer1MTokens } : {}),
  };

  // 3. API.
  const apiPort = options.apiPort ?? (await prompt.askNumber(
    'HTTP API port',
    existing.api?.port ?? 8080,
    (n) => (Number.isInteger(n) && n > 0 && n <= 65535 ? null : 'Ports run from 1 to 65535.')
  ));
  const bearer = await prompt.confirm('Require an API key from clients?', existing.api?.bearerAuthentication ?? false);
  const keys = bearer ? (existing.api?.keys?.length ? existing.api.keys : [generateApiKey()]) : (existing.api?.keys ?? ['diiisco']);

  config.api = {
    enabled: true,
    bearerAuthentication: bearer,
    keys,
    port: apiPort,
    networkWaitTime: existing.api?.networkWaitTime ?? 10000,
  };

  // 4. Wallet (public mode only) and 5. identity.
  if (mode === 'local') {
    config.local = {
      enabled: true,
      privateTopic: existing.local?.privateTopic ?? generatePrivateTopic(),
    };
    delete config.algorand;
  } else {
    config.local = { enabled: false };
    config.algorand = await buildWallet(prompt, options, existing, mnemonicFromStdin);
  }

  const displayName = await prompt.ask('Node display name', existing.node?.displayName ?? 'DIIISCO Node');
  config.node = { ...existing.node, displayName };

  if (mode === 'public') {
    const nfd = (await prompt.ask('NFD name (optional, e.g. my-node.diiisco.algo)', existing.algorand?.nfd ?? '')).trim();
    if (nfd !== '') config.algorand!.nfd = nfd;
    else delete config.algorand!.nfd;
  }

  return config;
}

async function buildWallet(
  prompt: Prompter,
  options: SetupOptions,
  existing: EnvironmentFile,
  mnemonicFromStdin: string | null
): Promise<NonNullable<EnvironmentFile['algorand']>> {
  const network = normaliseNetwork(
    options.network ?? (await prompt.choose('Network', ['mainnet', 'testnet'] as const, existing.algorand?.network ?? 'mainnet'))
  );

  const mnemonic = await resolveMnemonic(prompt, options, existing, mnemonicFromStdin);

  const defaultAlgod = network === 'mainnet'
    ? 'https://mainnet-api.algonode.cloud/'
    : 'https://testnet-api.algonode.cloud/';
  const algod = await prompt.ask('Algod URL', existing.algorand?.client?.address ?? defaultAlgod);

  const maxSpend = options.maxSpend ?? (await prompt.askNumber(
    'Max spend per request (USDC)',
    existing.algorand?.settlement?.maxSpend ?? 0.1,
    (n) => (n > 0 ? null : 'It has to be greater than 0 — this is the ceiling on a single request.')
  ));

  return {
    mnemonic,
    network,
    client: {
      address: algod,
      port: existing.algorand?.client?.port ?? 443,
      token: existing.algorand?.client?.token ?? '',
    },
    settlement: {
      methods: ['x402'],
      maxSpend,
      x402: { ...existing.algorand?.settlement?.x402, selfSubmitFallback: existing.algorand?.settlement?.x402?.selfSubmitFallback ?? true },
    },
    ...(existing.algorand?.nfd ? { nfd: existing.algorand.nfd } : {}),
  };
}

/**
 * Where a wallet comes from, in priority order: `--mnemonic-stdin`, the wallet
 * already on this machine (`algorand-key.json`, or a not-yet-migrated config),
 * then an interactive choice between pasting one and generating a fresh
 * account.
 *
 * A mnemonic is never accepted as a command-line argument (it would land in the
 * shell history and in `ps` output), and a wallet is never generated silently
 * in a non-interactive run.
 */
async function resolveMnemonic(
  prompt: Prompter,
  options: SetupOptions,
  existing: EnvironmentFile,
  mnemonicFromStdin: string | null
): Promise<string> {
  if (mnemonicFromStdin !== null) {
    if (mnemonicFromStdin === '') die('--mnemonic-stdin was given but stdin was empty.');
    assertMnemonic(mnemonicFromStdin);
    return mnemonicFromStdin;
  }

  // The key file is where a wallet lives now; the config is the pre-migration
  // fallback, so "keep" works on a machine that has not started the new node yet.
  const current = readKeyFile()?.mnemonic ?? existing.algorand?.mnemonic;

  if (!prompt.interactive) {
    if (current) return current;
    die(
      'Public mode needs a wallet, and this run cannot prompt for one.',
      'Pipe an existing mnemonic in with `diiisco setup --public --yes --mnemonic-stdin < wallet.txt`.',
      'Or drop --yes and run it interactively to generate a fresh account.'
    );
  }

  const choices = current ? (['keep', 'paste', 'generate'] as const) : (['paste', 'generate'] as const);
  const choice = await prompt.choose(
    current ? 'Wallet — keep the existing one, paste another, or generate a new account' : 'Wallet — paste an existing mnemonic or generate a new account',
    choices,
    (current ? 'keep' : 'paste') as 'keep' | 'paste' | 'generate'
  );

  if (choice === 'keep' && current) return current;

  if (choice === 'generate') {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    prompt.write('');
    prompt.write(`  Generated account: ${account.addr.toString()}`);
    prompt.write('  Its 25-word mnemonic is stored in algorand-key.json (mode 0600) and nowhere else.');
    prompt.write('  Back that file up: losing it loses the wallet, and anyone who reads it owns the funds.');
    prompt.write('  The account needs a small ALGO balance before the node can opt into USDC and DSCO.');
    prompt.write('');
    return mnemonic;
  }

  const pasted = (await prompt.secret('25-word wallet mnemonic (input hidden): ')).trim();
  if (pasted === '') die('A mnemonic is required for public mode.', 'Run `diiisco setup --local` for a payment-free node instead.');
  assertMnemonic(pasted);
  return pasted;
}

/** The keystore's check, in `die()` form — setup reports rather than throws. */
function assertMnemonic(mnemonic: string): void {
  try {
    assertUsableMnemonic(mnemonic);
  } catch (err: any) {
    die(err?.message ?? String(err));
  }
}

function normaliseNetwork(value: string): 'mainnet' | 'testnet' {
  const network = value.trim().toLowerCase();
  if (network !== 'mainnet' && network !== 'testnet') {
    die(`Unknown network "${value}".`, 'Use mainnet or testnet.');
  }
  return network;
}

/** Split `http://localhost:11434` into the `baseURL` + `port` the config wants. */
export function splitModelsUrl(raw: string): { baseURL: string; port: number } {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    die(`"${raw}" is not a URL.`, 'Expected something like http://localhost:11434');
  }

  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { baseURL: `${url.protocol}//${url.hostname}`, port };
}

/**
 * Probe the inference backend and say what it found. A backend that is not up
 * yet is a warning, not a failure — it may well start after the node does.
 */
async function reportBackend(prompt: Prompter, options: SetupOptions, baseURL: string, port: number): Promise<void> {
  const endpoint = `${baseURL}:${port}/v1/models`;
  const models = await probeModels(endpoint);

  if (models === null) {
    const message = `No inference backend answered at ${baseURL}:${port}. Start it (e.g. \`ollama serve\`) before \`diiisco start\`.`;
    if (options.print) prompt.write(`! ${message}`);
    else warn(message);
    return;
  }

  if (models.length === 0) {
    const message = `${baseURL}:${port} is up but serving no models. Pull one (e.g. \`ollama pull gemma3\`).`;
    if (options.print) prompt.write(`! ${message}`);
    else warn(message);
    return;
  }

  const shown = models.slice(0, 8);
  const suffix = models.length > shown.length ? ` (+${models.length - shown.length} more)` : '';
  if (options.print) prompt.write(`  ${models.length} model(s): ${shown.join(', ')}${suffix}`);
  else info(colour.dim(`  ${models.length} model(s) available: ${shown.join(', ')}${suffix}`));
}

async function probeModels(endpoint: string): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body?.data)) return null;
    return body.data.map((entry) => String(entry?.id ?? '')).filter((id) => id !== '');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
