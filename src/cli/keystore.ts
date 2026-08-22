/**
 * The wallet key file — `algorand-key.json`.
 *
 * A node's 25-word mnemonic is full spending authority over its wallet, and
 * `diiisco.config.json` is the file users hand-edit, paste into issues, copy
 * between machines and screen-share. So the key lives alone, in its own `0600`
 * file, and the config holds settings only.
 *
 * This module is deliberately **path-agnostic**: every function takes an
 * explicit path, so it never imports `config.ts` (which imports this). The
 * `~/.diiisco`-aware wrappers live there instead.
 *
 * Nothing here ever logs or prints a mnemonic. Where a wallet has to be named
 * to a user — a conflict between two files, say — it is named by its derived
 * **address**.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import algosdk from 'algosdk';
import { ConfigError } from './errors';

/** The key file's name, alongside `diiisco.config.json`. */
export const KEY_FILENAME = 'algorand-key.json';

/** The on-disk shape. `address` is derived, stored only so a human can read it. */
export interface WalletKeyFile {
  version: 1;
  mnemonic: string;
  address: string;
  updatedAt: string;
}

export function keyFilePathIn(dir: string): string {
  return join(dir, KEY_FILENAME);
}

/** The address a mnemonic derives to. Throws `ConfigError` when it is not a valid mnemonic. */
export function addressOf(mnemonic: string): string {
  assertMnemonic(mnemonic);
  return algosdk.mnemonicToSecretKey(normalise(mnemonic)).addr.toString();
}

/**
 * Whether two mnemonics are the same wallet.
 *
 * Compared on the derived address rather than the string, so a difference in
 * whitespace, line endings or casing is not mistaken for a different wallet.
 */
export function sameWallet(a: string, b: string): boolean {
  if (normalise(a) === normalise(b)) return true;
  try {
    return addressOf(a) === addressOf(b);
  } catch {
    return false;
  }
}

/** 25 words, and algosdk agrees. Throws `ConfigError` describing the problem. */
export function assertMnemonic(mnemonic: string): void {
  const words = normalise(mnemonic).split(' ').filter((word) => word !== '');
  if (words.length !== 25) {
    throw new ConfigError(`That is ${words.length} word(s); an Algorand mnemonic is 25.`);
  }
  try {
    algosdk.mnemonicToSecretKey(words.join(' '));
  } catch (err: any) {
    throw new ConfigError(`That mnemonic is not valid: ${err?.message ?? err}`);
  }
}

/** Collapse whitespace and case so two spellings of one mnemonic compare equal. */
function normalise(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Read the key file, or `null` when there is none.
 *
 * A file that exists but cannot be used is an error rather than a `null`: a
 * node that silently fell back to "no wallet" here would go on to fail much
 * further downstream, with a message about the config file instead.
 */
export function readKeyFileAt(path: string): WalletKeyFile | null {
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err: any) {
    throw new ConfigError(`Could not read ${path}: ${err?.message ?? err}`);
  }

  if (raw.trim() === '') return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('top level value is not a JSON object');
    }
  } catch (err: any) {
    throw new ConfigError(`${path} is not valid JSON: ${err?.message ?? err}`, [
      'This file holds your wallet key — do not delete it unless you have the 25 words elsewhere.',
      'Restore it from your backup, or re-create it with `diiisco setup --public`.',
    ]);
  }

  if (typeof parsed.mnemonic !== 'string' || parsed.mnemonic.trim() === '') {
    throw new ConfigError(`${path} has no \`mnemonic\`.`, [
      'Restore it from your backup, or re-create it with `diiisco setup --public`.',
    ]);
  }

  let address: string;
  try {
    address = addressOf(parsed.mnemonic);
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message : String(err);
    throw new ConfigError(`The mnemonic in ${path} is not usable: ${detail}`, [
      'Restore it from your backup, or re-create it with `diiisco setup --public`.',
    ]);
  }

  // `address` is a convenience for humans, never an input. If it disagrees with
  // the mnemonic the file has been hand-edited into an ambiguous state, and
  // guessing which half was meant is exactly the guess this change exists to
  // avoid making.
  if (typeof parsed.address === 'string' && parsed.address !== '' && parsed.address !== address) {
    throw new ConfigError(
      `${path} is inconsistent: its \`address\` is not the one its \`mnemonic\` derives to.`,
      [
        `The mnemonic derives to ${address}, but the file records ${parsed.address}.`,
        'The mnemonic is the wallet — correct or remove the `address` field to continue.',
      ]
    );
  }

  return {
    version: 1,
    mnemonic: normalise(parsed.mnemonic),
    address,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

/**
 * Write the key file with owner-only permissions.
 *
 * Mirrors `writeConfigFile`: the mode covers a file we create, and the explicit
 * `chmod` covers one an older CLI (or a hand copy) left behind looser.
 */
export function writeKeyFileAt(path: string, mnemonic: string): WalletKeyFile {
  const key: WalletKeyFile = {
    version: 1,
    mnemonic: normalise(mnemonic),
    address: addressOf(mnemonic),
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / exotic filesystems: best effort.
  }

  return key;
}
