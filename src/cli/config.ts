import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Environment } from '../environment/environment.types';
import { withDefaults } from '../environment/defaults';
import { validateEnvironment } from '../environment/validate';
import { configPath, diiiscoHome, ensureHome, firstRunMarkerPath } from './paths';

/**
 * Topic used when local mode is inferred rather than configured. It is stable
 * so two zero-config nodes on the same LAN discover each other over mDNS, and
 * distinct from the public topic so a payment-free node never advertises onto
 * the public network it cannot settle on.
 */
export const IMPLICIT_LOCAL_TOPIC = 'diiisco-local/models/1.0.0';

export class ConfigError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.hints = hints;
  }
}

/** Read and parse `~/.diiisco/config.json`, or `null` when it does not exist. */
export function readConfigFile(): Partial<Environment> | null {
  const path = configPath();
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err: any) {
    throw new ConfigError(`Could not read ${path}: ${err?.message ?? err}`);
  }

  if (raw.trim() === '') return null;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('top level value is not a JSON object');
    }
    return parsed as Partial<Environment>;
  } catch (err: any) {
    throw new ConfigError(`${path} is not valid JSON: ${err?.message ?? err}`, [
      'Fix the file by hand, or re-create it with `diiisco config init --local`.',
    ]);
  }
}

/**
 * Load the effective configuration: defaults + `~/.diiisco/config.json`.
 *
 * With no config file at all the node falls back to **local mode** rather than
 * erroring, so `diiisco launch claude` works on a clean machine. Local mode is
 * payment-free and uses an ephemeral signing key.
 */
export function loadConfig(): Environment {
  const file = readConfigFile();
  const env = withDefaults(file);

  // Keep everything inside one directory: unless the user pinned an explicit
  // `peerIdStorage.path`, the peer identity lives alongside config.json and the
  // logs, so `DIIISCO_HOME` isolates a node completely (tests, multiple nodes
  // on one host, a portable install).
  if (!file?.peerIdStorage?.path) {
    env.peerIdStorage = { ...env.peerIdStorage, path: diiiscoHome() };
  }

  if (!file) {
    env.local = { enabled: true, privateTopic: IMPLICIT_LOCAL_TOPIC };
  } else if (env.local?.enabled && !env.local.privateTopic) {
    env.local.privateTopic = IMPLICIT_LOCAL_TOPIC;
  }

  return env;
}

/** True when the user has never been shown the first-run notice. */
export function isFirstRun(): boolean {
  return !existsSync(configPath()) && !existsSync(firstRunMarkerPath());
}

/**
 * Print the one-time notice explaining that the node is running payment-free
 * and how to join the public network, then record that it has been shown.
 */
export function markFirstRunSeen(): void {
  try {
    ensureHome();
    writeFileSync(firstRunMarkerPath(), `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    // A notice we cannot suppress is better than a crash.
  }
}

/** Validate a merged environment, throwing a `ConfigError` listing every problem. */
export function assertValid(env: Environment): void {
  const errors = validateEnvironment(env);
  if (errors.length === 0) return;
  const [first, ...rest] = errors;
  throw new ConfigError(first, rest);
}

/** Write `~/.diiisco/config.json` with owner-only permissions (it holds a mnemonic). */
export function writeConfigFile(config: Partial<Environment>): string {
  ensureHome();
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / exotic filesystems: best effort.
  }
  return path;
}

/** A random, per-cluster private topic for `config init --local`. */
export function generatePrivateTopic(): string {
  return `diiisco-local-${randomBytes(4).toString('hex')}/models/1.0.0`;
}

const REDACTED = '<redacted>';

/**
 * A JSON-safe, secret-free view of the effective config.
 *
 * Two things must never leave the process: `algorand.mnemonic` (spending
 * authority) and `api.keys` (access to this node's inference). Functions
 * (`quoteSelectionFunction` and friends) are not JSON-representable, so they
 * are rendered by name.
 */
export function redactConfig(env: Environment): Record<string, unknown> {
  const clone = toSerializable(env) as Record<string, any>;

  if (clone.algorand && typeof clone.algorand === 'object' && 'mnemonic' in clone.algorand) {
    clone.algorand.mnemonic = REDACTED;
  }
  if (clone.api && Array.isArray(clone.api.keys)) {
    clone.api.keys = clone.api.keys.map(() => REDACTED);
  }

  return clone;
}

function toSerializable(value: unknown): unknown {
  if (typeof value === 'function') {
    const name = (value as { name?: string }).name;
    return `[Function: ${name && name !== '' ? name : 'anonymous'}]`;
  }
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toSerializable(item);
    }
    return out;
  }
  return value;
}

/** The endpoint clients should point at, derived from the effective config. */
export function apiEndpoint(env: Environment): string {
  return `http://localhost:${env.api.port ?? 8080}`;
}

/** The API key a client should present, or `undefined` when auth is off. */
export function apiKey(env: Environment): string | undefined {
  if (!env.api.bearerAuthentication) return env.api.keys?.[0];
  return env.api.keys?.[0];
}
