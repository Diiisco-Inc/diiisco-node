/**
 * The wallet key file and the migration that fills it.
 *
 * These run against `src/` rather than the compiled binary (as
 * `anthropicAdapter.test.ts` does): the interesting cases are what is left on
 * disk after a migration, a conflict or a crash-shaped partial write, and
 * driving those through the CLI would mean starting real nodes.
 *
 * Every test gets its own `DIIISCO_HOME`. Nothing here may touch the real
 * `~/.diiisco`, and every wallet is a throwaway generated on the spot.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import algosdk from 'algosdk';
import {
  ConfigError,
  configPath,
  keyFilePath,
  loadConfig,
  readKeyFile,
  redactConfig,
  setConfigPathOverride,
  writeKeyFile,
} from '../src/cli/config';
import { migrateWalletKey } from '../src/cli/keyMigration';

interface Wallet {
  mnemonic: string;
  address: string;
}

function wallet(): Wallet {
  const account = algosdk.generateAccount();
  return { mnemonic: algosdk.secretKeyToMnemonic(account.sk), address: account.addr.toString() };
}

let home: string;
const previousHome = process.env.DIIISCO_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'diiisco-keystore-'));
  process.env.DIIISCO_HOME = home;
  setConfigPathOverride(null);
});

afterEach(() => {
  setConfigPathOverride(null);
  if (previousHome === undefined) delete process.env.DIIISCO_HOME;
  else process.env.DIIISCO_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** A public-mode config, with or without a wallet key in it. */
function writeConfig(mnemonic?: string, extra: Record<string, unknown> = {}): string {
  const path = join(home, 'diiisco.config.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        models: { enabled: false, baseURL: 'http://localhost', port: 11434, apiKey: '' },
        api: { enabled: true, bearerAuthentication: false, keys: ['diiisco'], port: 8080 },
        algorand: {
          ...(mnemonic === undefined ? {} : { mnemonic }),
          network: 'testnet',
          client: { address: 'https://testnet-api.algonode.cloud/', port: 443, token: '' },
          settlement: { methods: ['x402'], maxSpend: 0.1 },
        },
        ...extra,
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return path;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('migrating a wallet key out of the config', () => {
  test('moves the key to its own 0600 file and takes it out of the config', () => {
    const alice = wallet();
    const config = writeConfig(alice.mnemonic);

    const result = migrateWalletKey();
    expect(result.outcome).toBe('migrated');
    expect(result.keyFile).toBe(join(home, 'algorand-key.json'));

    const key = readJson(result.keyFile);
    expect(key.mnemonic).toBe(alice.mnemonic);
    expect(key.address).toBe(alice.address);
    expect(key.version).toBe(1);

    // Owner-only. Windows has no meaningful mode here.
    if (process.platform !== 'win32') {
      expect(statSync(result.keyFile).mode & 0o777).toBe(0o600);
    }

    // The config keeps its settings and loses only the key.
    const after = readJson(config);
    expect(after.algorand.mnemonic).toBeUndefined();
    expect(after.algorand.network).toBe('testnet');
    expect(after.api.port).toBe(8080);

    // And the node still runs as the same wallet.
    expect(loadConfig().algorand!.mnemonic).toBe(alice.mnemonic);
  });

  test('is idempotent — a second run changes nothing', () => {
    writeConfig(wallet().mnemonic);
    migrateWalletKey();

    const config = readFileSync(configPath(), 'utf8');
    const key = readFileSync(keyFilePath(), 'utf8');

    expect(migrateWalletKey().outcome).toBe('none');
    expect(readFileSync(configPath(), 'utf8')).toBe(config);
    expect(readFileSync(keyFilePath(), 'utf8')).toBe(key);
  });

  test('removes a duplicate copy of the same wallet without rewriting the key file', () => {
    const alice = wallet();
    writeKeyFile(alice.mnemonic);
    const key = readFileSync(keyFilePath(), 'utf8');
    // The same wallet, spelled differently — this is a duplicate, not a conflict.
    const config = writeConfig(`  ${alice.mnemonic.toUpperCase()}  `);

    expect(migrateWalletKey().outcome).toBe('stripped');
    expect(readJson(config).algorand.mnemonic).toBeUndefined();
    expect(readFileSync(keyFilePath(), 'utf8')).toBe(key);
  });

  test('two different wallets stop the node and change neither file', () => {
    const alice = wallet();
    const bob = wallet();
    writeKeyFile(alice.mnemonic);
    const config = writeConfig(bob.mnemonic);

    const configBefore = readFileSync(config, 'utf8');
    const keyBefore = readFileSync(keyFilePath(), 'utf8');

    expect(() => migrateWalletKey()).toThrow(ConfigError);

    let thrown: ConfigError | null = null;
    try {
      migrateWalletKey();
    } catch (err) {
      thrown = err as ConfigError;
    }

    const said = [thrown!.message, ...thrown!.hints].join('\n');
    expect(said).toContain(alice.address);
    expect(said).toContain(bob.address);
    // Naming the wallets must not mean printing them.
    expect(said).not.toContain(alice.mnemonic);
    expect(said).not.toContain(bob.mnemonic);

    expect(readFileSync(config, 'utf8')).toBe(configBefore);
    expect(readFileSync(keyFilePath(), 'utf8')).toBe(keyBefore);
  });

  test('refuses to write anything when the config holds an unusable key', () => {
    const config = writeConfig('not actually a mnemonic');
    const before = readFileSync(config, 'utf8');

    expect(() => migrateWalletKey()).toThrow(ConfigError);
    expect(existsSync(keyFilePath())).toBe(false);
    expect(readFileSync(config, 'utf8')).toBe(before);
  });

  test('does nothing for a config that never had a wallet', () => {
    writeConfig();
    expect(migrateWalletKey().outcome).toBe('none');
    expect(existsSync(keyFilePath())).toBe(false);
  });
});

describe('loading the wallet key', () => {
  test('a key file alone supplies the wallet, and stays redacted', () => {
    const alice = wallet();
    writeConfig();
    writeKeyFile(alice.mnemonic);

    const env = loadConfig();
    expect(env.algorand!.mnemonic).toBe(alice.mnemonic);
    expect((redactConfig(env) as any).algorand.mnemonic).toBe('<redacted>');
  });

  test('a conflict is refused on the read path too, not just at migration', () => {
    writeKeyFile(wallet().mnemonic);
    writeConfig(wallet().mnemonic);
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test('a stray key file does not turn a local-mode node into a public one', () => {
    writeFileSync(
      join(home, 'diiisco.config.json'),
      `${JSON.stringify({
        models: { enabled: false, baseURL: 'http://localhost', port: 11434, apiKey: '' },
        api: { enabled: true, bearerAuthentication: false, keys: ['diiisco'], port: 8080 },
        local: { enabled: true, privateTopic: 'diiisco-test/models/1.0.0' },
      })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    writeKeyFile(wallet().mnemonic);

    expect(loadConfig().algorand).toBeUndefined();
  });

  test('a key file whose address contradicts its mnemonic is an error, not a guess', () => {
    writeConfig();
    const path = writeKeyFile(wallet().mnemonic);
    const key = readJson(path);
    writeFileSync(path, `${JSON.stringify({ ...key, address: wallet().address }, null, 2)}\n`);

    expect(() => readKeyFile()).toThrow(ConfigError);
  });
});

describe('where the key file lives', () => {
  test('it follows DIIISCO_HOME', () => {
    expect(keyFilePath()).toBe(join(home, 'algorand-key.json'));
  });

  test('it follows --config, so an alternate config stays self-contained', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'diiisco-alt-'));
    try {
      setConfigPathOverride(join(elsewhere, 'other.json'));
      expect(keyFilePath()).toBe(join(elsewhere, 'algorand-key.json'));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
