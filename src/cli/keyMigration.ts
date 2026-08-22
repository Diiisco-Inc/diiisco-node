/**
 * Moving a wallet key out of `diiisco.config.json` and into `algorand-key.json`.
 *
 * Every node that was set up before the split still has its mnemonic in the
 * config, so the move happens on startup rather than being something a user has
 * to know about. It runs on every start and is idempotent.
 */
import {
  ConfigError,
  configPath,
  keyFilePath,
  readConfigFile,
  readKeyFile,
  walletConflictError,
  withoutMnemonic,
  writeConfigFile,
  writeKeyFile,
} from './config';
import { assertMnemonic, sameWallet } from './keystore';

export type MigrationOutcome =
  /** Nothing to do: the key is already in its own file, or there is no wallet. */
  | 'none'
  /** The key was moved out of the config into a new key file. */
  | 'migrated'
  /** The key file already held this wallet; the stray config copy was removed. */
  | 'stripped';

export interface MigrationResult {
  outcome: MigrationOutcome;
  keyFile: string;
}

/**
 * Move `algorand.mnemonic` from the config into the key file.
 *
 * Throws a `ConfigError` — and writes nothing — when the two files name
 * different wallets, or when the config's mnemonic is not usable.
 */
export function migrateWalletKey(): MigrationResult {
  const keyFile = keyFilePath();
  const file = readConfigFile();
  const fromConfig = file?.algorand?.mnemonic?.trim();

  if (!file || !fromConfig) return { outcome: 'none', keyFile };

  // A broken value in the config must never overwrite a good key file, and must
  // never become the contents of a new one.
  try {
    assertMnemonic(fromConfig);
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message : String(err);
    throw new ConfigError(`\`algorand.mnemonic\` in ${configPath()} is not a usable wallet key: ${detail}`, [
      'Nothing has been changed.',
      'Fix it by hand, or remove it and re-run `diiisco setup --public`.',
    ]);
  }

  const existing = readKeyFile();

  if (existing && !sameWallet(existing.mnemonic, fromConfig)) {
    throw walletConflictError(existing.address, fromConfig);
  }

  // The key file is written *first*. If the process dies between the two
  // writes, the mnemonic is still in both files, which the next start resolves
  // as the 'stripped' case below. The key can never be dropped on the floor.
  if (!existing) writeKeyFile(fromConfig);

  writeConfigFile(withoutMnemonic(file));

  return { outcome: existing ? 'stripped' : 'migrated', keyFile };
}
