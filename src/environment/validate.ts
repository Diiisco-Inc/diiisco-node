import { Environment } from './environment.types';

/**
 * Validate a fully-merged environment and return human-actionable problems.
 *
 * Returns an empty array when the config is usable. Every message is written to
 * be printed verbatim to a user: it says what is wrong *and* what to type next.
 * Callers should fail fast on a non-empty result rather than letting the node
 * die later with a stack trace from deep inside libp2p or algosdk.
 */
export function validateEnvironment(env: Environment): string[] {
  const errors: string[] = [];
  const isLocal = env.local?.enabled === true;

  if (!isLocal) {
    if (!env.algorand) {
      errors.push(
        'No wallet configured. Run `diiisco config init --public`, or enable local mode with `diiisco config init --local`.'
      );
    } else {
      if (!env.algorand.mnemonic || env.algorand.mnemonic.trim() === '') {
        errors.push(
          'No wallet configured: `algorand.mnemonic` is empty. Run `diiisco config init --public`, or enable local mode with `diiisco config init --local`.'
        );
      } else if (env.algorand.mnemonic.trim().split(/\s+/).length !== 25) {
        errors.push(
          '`algorand.mnemonic` does not look like an Algorand mnemonic (expected 25 space-separated words). Re-run `diiisco config init --public`.'
        );
      }

      if (!env.algorand.client?.address) {
        errors.push(
          'No Algorand node configured: set `algorand.client.address` (e.g. "https://mainnet-api.algonode.cloud/") in `diiisco config path`.'
        );
      }

      if (env.algorand.network && env.algorand.network !== 'mainnet' && env.algorand.network !== 'testnet') {
        errors.push(
          `Unknown \`algorand.network\` "${env.algorand.network}". Use "mainnet" or "testnet".`
        );
      }

      const settlement = env.algorand.settlement;
      if (!settlement) {
        errors.push(
          'No settlement configured: add an `algorand.settlement` block with a `maxSpend` budget, or enable local mode with `diiisco config init --local`.'
        );
      } else if (settlement.maxSpend === undefined) {
        errors.push(
          'No spending limit configured: set `algorand.settlement.maxSpend` (USDC per request). Without it this node refuses to pay for any inference.'
        );
      } else if (!(settlement.maxSpend > 0)) {
        errors.push(
          `\`algorand.settlement.maxSpend\` must be greater than 0 (got ${settlement.maxSpend}).`
        );
      }
    }
  }

  if (env.models.enabled) {
    if (!env.models.baseURL) {
      errors.push('`models.baseURL` is empty. Point it at your inference server, e.g. "http://localhost" with `models.port` 11434 for Ollama.');
    }
    if (!Number.isInteger(env.models.port) || env.models.port <= 0 || env.models.port > 65535) {
      errors.push(`\`models.port\` must be a port number between 1 and 65535 (got ${env.models.port}).`);
    }
  }

  if (env.api.enabled) {
    if (!Number.isInteger(env.api.port) || env.api.port <= 0 || env.api.port > 65535) {
      errors.push(`\`api.port\` must be a port number between 1 and 65535 (got ${env.api.port}).`);
    }
    if (env.api.bearerAuthentication && (!Array.isArray(env.api.keys) || env.api.keys.length === 0)) {
      errors.push('`api.bearerAuthentication` is on but `api.keys` is empty — no client could ever authenticate. Add a key or set `api.bearerAuthentication` to false.');
    }
  }

  if (!env.peerIdStorage?.path) {
    errors.push('`peerIdStorage.path` is empty. Set it to a directory the node may write its peer identity to (default "~/.diiisco").');
  }

  if (isLocal && !env.local?.privateTopic) {
    errors.push('Local mode needs a `local.privateTopic` to isolate this cluster. Run `diiisco config init --local` to generate one.');
  }

  return errors;
}
