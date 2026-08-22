import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Environment, EnvironmentFile } from '../environment/environment.types';
import { withDefaults } from '../environment/defaults';
import { validateEnvironment } from '../environment/validate';
import { resolveStrategies, StrategyError, strategyName } from '../environment/strategies';
import { diiiscoHome, ensureHome, expandTilde } from './paths';
import { ConfigError } from './errors';
import {
  KEY_FILENAME,
  WalletKeyFile,
  addressOf,
  keyFilePathIn,
  readKeyFileAt,
  sameWallet,
  writeKeyFileAt,
} from './keystore';

/** The config file's name since the CLI took ownership of `~/.diiisco`. */
export const CONFIG_FILENAME = 'diiisco.config.json';

/** The name used by the first CLI drafts; still read, with a deprecation notice. */
export const LEGACY_CONFIG_FILENAME = 'config.json';

// Re-exported so the many `import { ConfigError } from '../config'` call sites
// keep working; the class itself lives in `errors.ts` so `keystore.ts` can throw
// it without an import cycle.
export { ConfigError };

/** Set by the global `--config <path>` flag; highest-priority location. */
let configPathOverride: string | null = null;

export function setConfigPathOverride(path: string | null): void {
  if (path === null || path.trim() === '') {
    configPathOverride = null;
    return;
  }
  const expanded = expandTilde(path.trim());
  configPathOverride = isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Where the config file lives. In priority order:
 *   1. `--config <path>`
 *   2. `$DIIISCO_CONFIG` (a full path)
 *   3. `$DIIISCO_HOME/diiisco.config.json`
 *   4. `~/.diiisco/diiisco.config.json`
 *
 * (3) and (4) are one expression: `diiiscoHome()` already resolves
 * `DIIISCO_HOME` with `~/.diiisco` as its fallback.
 */
export function configPath(): string {
  if (configPathOverride) return configPathOverride;
  const fromEnv = process.env.DIIISCO_CONFIG?.trim();
  if (fromEnv) {
    const expanded = expandTilde(fromEnv);
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return join(diiiscoHome(), CONFIG_FILENAME);
}

/** The pre-rename location, only consulted inside the DIIISCO home. */
export function legacyConfigPath(): string {
  return join(diiiscoHome(), LEGACY_CONFIG_FILENAME);
}

export interface ConfigLocation {
  /** The path the CLI will read. */
  path: string;
  exists: boolean;
  /** True when what is being read is the deprecated `config.json`. */
  legacy: boolean;
}

/**
 * Resolve which file is actually in play. A legacy `config.json` is honoured
 * only when no `diiisco.config.json` exists and no explicit location was given
 * — it is read, never migrated or deleted.
 */
export function configLocation(): ConfigLocation {
  const path = configPath();
  if (existsSync(path)) return { path, exists: true, legacy: false };

  const explicit = configPathOverride !== null || Boolean(process.env.DIIISCO_CONFIG?.trim());
  if (!explicit) {
    const legacy = legacyConfigPath();
    if (existsSync(legacy)) return { path: legacy, exists: true, legacy: true };
  }

  return { path, exists: false, legacy: false };
}

export function configExists(): boolean {
  return configLocation().exists;
}

let legacyNoticeShown = false;

/** Read and parse the config file, or `null` when there is none. */
export function readConfigFile(): EnvironmentFile | null {
  const location = configLocation();
  if (!location.exists) return null;

  if (location.legacy && !legacyNoticeShown) {
    legacyNoticeShown = true;
    process.stderr.write(
      `! Reading the deprecated ${location.path} — rename it to ${configPath()}.\n`
    );
  }

  let raw: string;
  try {
    raw = readFileSync(location.path, 'utf8');
  } catch (err: any) {
    throw new ConfigError(`Could not read ${location.path}: ${err?.message ?? err}`);
  }

  if (raw.trim() === '') return null;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('top level value is not a JSON object');
    }
    return parsed as EnvironmentFile;
  } catch (err: any) {
    throw new ConfigError(`${location.path} is not valid JSON: ${err?.message ?? err}`, [
      'Fix the file by hand, or re-create it with `diiisco setup --force`.',
    ]);
  }
}

/**
 * Where the wallet key lives: beside the config file, so `DIIISCO_HOME`,
 * `$DIIISCO_CONFIG` and `--config` all move the two together and an alternate
 * config stays self-contained. In the ordinary case that is
 * `~/.diiisco/algorand-key.json`.
 */
export function keyFilePath(): string {
  return keyFilePathIn(dirname(configPath()));
}

export function keyFileExists(): boolean {
  return existsSync(keyFilePath());
}

/** Read the wallet key file, or `null` when there is none. */
export function readKeyFile(): WalletKeyFile | null {
  return readKeyFileAt(keyFilePath());
}

/** Write the wallet key file (mode 0600), creating `~/.diiisco` if needed. */
export function writeKeyFile(mnemonic: string): string {
  const path = keyFilePath();
  if (path.startsWith(diiiscoHome())) ensureHome();
  writeKeyFileAt(path, mnemonic);
  return path;
}

export interface WalletResolution {
  /** The mnemonic to run with, if there is one. */
  mnemonic?: string;
  source: 'keyfile' | 'config' | 'none';
  /** True when a copy still sits in the config file and wants moving out. */
  needsMigration: boolean;
}

/**
 * Decide which wallet a node should run as, given what is in the config file
 * and what is in the key file.
 *
 * The key file wins, and a leftover copy of the *same* wallet in the config is
 * just something to tidy up. Two **different** wallets is not a precedence
 * question: picking either one silently changes which account is spending, so
 * it stops here instead.
 */
export function resolveWalletKey(file: EnvironmentFile | null): WalletResolution {
  const fromConfig = file?.algorand?.mnemonic?.trim();
  const key = readKeyFile();

  if (!key) {
    if (!fromConfig) return { source: 'none', needsMigration: false };
    return { mnemonic: fromConfig, source: 'config', needsMigration: true };
  }

  if (!fromConfig) return { mnemonic: key.mnemonic, source: 'keyfile', needsMigration: false };

  if (sameWallet(key.mnemonic, fromConfig)) {
    return { mnemonic: key.mnemonic, source: 'keyfile', needsMigration: true };
  }

  throw walletConflictError(key.address, fromConfig);
}

/**
 * Two different wallets, named by address. The mnemonics themselves are never
 * printed — the address is enough for the user to tell which is which.
 */
export function walletConflictError(keyFileAddress: string, configMnemonic: string): ConfigError {
  let configAddress: string;
  try {
    configAddress = addressOf(configMnemonic);
  } catch {
    configAddress = '(not a valid mnemonic)';
  }

  return new ConfigError('Two different Algorand wallets are configured, so the node will not start.', [
    `${keyFilePath()}  ${keyFileAddress}`,
    `${configPath()}  ${configAddress}`,
    'Neither file has been changed.',
    `To keep the key file's wallet: delete \`algorand.mnemonic\` from ${configPath()}.`,
    `To keep the config's wallet:   move ${KEY_FILENAME} aside and start again.`,
  ]);
}

/**
 * The effective configuration: `DEFAULT_ENVIRONMENT` filled in with the config
 * file, strategy names resolved to functions, and the wallet key read from
 * `algorand-key.json`.
 *
 * The defaults fill gaps in a real config; they are **not** a substitute for
 * one. A missing file yields the bare defaults here — callers that would
 * actually run the node must gate on `requireConfig()` first.
 */
export function loadConfig(): Environment {
  const file = readConfigFile();
  const wallet = resolveWalletKey(file);
  const env = mergeConfig(file);

  // Only fill in a block the config actually declares. A local-mode config with
  // a leftover key file must stay local, and an `algorand`-less public config
  // should keep failing `validateEnvironment` with its own message.
  if (wallet.mnemonic && env.algorand) env.algorand.mnemonic = wallet.mnemonic;

  return env;
}

/**
 * Merge an already-parsed config file over the defaults.
 *
 * Deliberately does **not** consult the key file: `setup` and `config edit`
 * validate an in-memory candidate that still carries its own mnemonic, and
 * would trip over a key file holding the wallet they are about to replace.
 * `loadConfig()` is the disk-backed path that resolves the wallet.
 */
export function mergeConfig(file: EnvironmentFile | null): Environment {
  let overrides: Partial<Environment> | null = null;
  if (file) {
    try {
      overrides = resolveStrategies(file);
    } catch (err) {
      if (err instanceof StrategyError) throw new ConfigError(err.message, err.hints);
      throw err;
    }
  }

  const env = withDefaults(overrides);

  // Keep everything inside one directory: unless the user pinned an explicit
  // `peerIdStorage.path`, the peer identity lives alongside the config and the
  // logs, so `DIIISCO_HOME` isolates a node completely.
  if (!file?.peerIdStorage?.path) {
    env.peerIdStorage = { ...env.peerIdStorage, path: diiiscoHome() };
  }

  return env;
}

/** Exit code for "this machine is not configured", distinct from a failure. */
export const EXIT_UNCONFIGURED = 2;

/**
 * Gate for every command that would actually run the node. There is no implicit
 * zero-config mode: a node needs an inference backend, an API key and (on the
 * public network) a wallet, and guessing at those produces a node that looks
 * started but serves nothing.
 */
export function requireConfig(): void {
  if (configExists()) return;
  process.stderr.write(
    `No DIIISCO configuration found.\n  Expected at: ${configPath()}\n\nRun \`diiisco setup\` to create one.\n`
  );
  process.exit(EXIT_UNCONFIGURED);
}

/** Validate a merged environment, throwing a `ConfigError` listing every problem. */
export function assertValid(env: Environment): void {
  const errors = validateEnvironment(env);
  if (errors.length === 0) return;
  const [first, ...rest] = errors;
  throw new ConfigError(first, rest);
}

/** Write the config file with owner-only permissions (it holds a mnemonic). */
export function writeConfigFile(config: EnvironmentFile, path = configPath()): string {
  if (path.startsWith(diiiscoHome())) ensureHome();
  writeFileSync(path, `${serializeConfig(config)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / exotic filesystems: best effort.
  }
  return path;
}

/**
 * A copy of a config with the wallet key taken out — what actually gets
 * written to `diiisco.config.json`. The key belongs in `algorand-key.json`.
 */
export function withoutMnemonic(config: EnvironmentFile): EnvironmentFile {
  if (!config.algorand || config.algorand.mnemonic === undefined) return config;
  const { mnemonic, ...algorand } = config.algorand;
  return { ...config, algorand };
}

/** Render a config as the JSON that belongs on disk (functions → strategy names). */
export function serializeConfig(config: EnvironmentFile): string {
  return JSON.stringify(toJsonConfig(config), null, 2);
}

/** A random, per-cluster private topic for local mode. */
export function generatePrivateTopic(): string {
  return `diiisco-local-${randomBytes(4).toString('hex')}/models/1.0.0`;
}

/** A fresh bearer key for the HTTP API. */
export function generateApiKey(): string {
  return `sk-diiisco-${randomBytes(24).toString('hex')}`;
}

const REDACTED = '<redacted>';

/**
 * A JSON-safe, secret-free view of a config.
 *
 * Two things must never leave the process: `algorand.mnemonic` (spending
 * authority) and `api.keys` (access to this node's inference).
 */
export function redactConfig(env: EnvironmentFile | Environment): Record<string, unknown> {
  const clone = toJsonConfig(env) as Record<string, any>;

  if (clone.algorand && typeof clone.algorand === 'object' && 'mnemonic' in clone.algorand) {
    clone.algorand.mnemonic = REDACTED;
  }
  if (clone.api && Array.isArray(clone.api.keys)) {
    clone.api.keys = clone.api.keys.map(() => REDACTED);
  }

  return clone;
}

/**
 * Convert a config to plain JSON, rendering the strategy hooks as **names**
 * rather than `[Function: …]` placeholders — so anything the CLI prints is
 * itself a valid config file.
 */
export function toJsonConfig(config: EnvironmentFile | Environment): Record<string, unknown> {
  return jsonify(config) as Record<string, unknown>;
}

function jsonify(value: unknown): unknown {
  if (typeof value === 'function') return strategyName(value) ?? 'unknown';
  if (Array.isArray(value)) return value.map(jsonify);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = jsonify(item);
    }
    return out;
  }
  return value;
}

/** The endpoint clients should point at, derived from the effective config. */
export function apiEndpoint(env: Environment): string {
  return `http://localhost:${env.api.port ?? 8080}`;
}
