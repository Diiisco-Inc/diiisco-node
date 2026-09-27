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
        'No wallet configured. Run `diiisco setup --public`, or enable local mode with `diiisco setup --local`.'
      );
    } else {
      // The wallet key is not a config field any more — it is loaded from
      // `algorand-key.json` — so these messages stay path-free and point at the
      // command that manages it. (This module is shared with library consumers,
      // which have no `~/.diiisco` at all.)
      if (!env.algorand.mnemonic || env.algorand.mnemonic.trim() === '') {
        errors.push(
          'No wallet key found. Run `diiisco setup --public`, or enable local mode with `diiisco setup --local`.'
        );
      } else if (env.algorand.mnemonic.trim().split(/\s+/).length !== 25) {
        errors.push(
          'The wallet key is not an Algorand mnemonic (expected 25 space-separated words). Re-run `diiisco setup --public`.'
        );
      }

      if (!env.algorand.client?.address) {
        errors.push(
          'No Algorand node configured: set `algorand.client.address` (e.g. "https://mainnet-api.algonode.cloud/") in `diiisco config edit`.'
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
          'No settlement configured: add an `algorand.settlement` block with a `maxSpend` budget, or enable local mode with `diiisco setup --local`.'
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

    const availability = env.models.availability;
    if (availability) {
      // checkIntervalMs may be 0 — that disables the background poll, leaving
      // the quote-path freshness check as the only probe.
      if (availability.checkIntervalMs !== undefined && (!Number.isInteger(availability.checkIntervalMs) || availability.checkIntervalMs < 0)) {
        errors.push(`\`models.availability.checkIntervalMs\` must be a whole number of milliseconds, 0 or greater (got ${availability.checkIntervalMs}).`);
      }
      if (availability.freshForMs !== undefined && (!Number.isInteger(availability.freshForMs) || availability.freshForMs < 0)) {
        errors.push(`\`models.availability.freshForMs\` must be a whole number of milliseconds, 0 or greater (got ${availability.freshForMs}).`);
      }
      if (availability.timeoutMs !== undefined && (!Number.isInteger(availability.timeoutMs) || availability.timeoutMs <= 0)) {
        errors.push(`\`models.availability.timeoutMs\` must be a whole number of milliseconds greater than 0 (got ${availability.timeoutMs}).`);
      }
    }
  }

  const quoteEngine = env.quoteEngine;
  if (quoteEngine) {
    if (quoteEngine.auctionTimeout !== undefined) {
      if (!(quoteEngine.auctionTimeout > 0)) {
        errors.push(`\`quoteEngine.auctionTimeout\` must be greater than 0 (got ${quoteEngine.auctionTimeout}).`);
      } else if (quoteEngine.auctionTimeout <= quoteEngine.waitTime) {
        // Not fatal, but it can only ever abandon the auction before the engine
        // has finished collecting quotes.
        errors.push(
          `\`quoteEngine.auctionTimeout\` (${quoteEngine.auctionTimeout}ms) is not greater than \`quoteEngine.waitTime\` (${quoteEngine.waitTime}ms), so every request would time out before a quote could be selected. Raise it above the wait time.`
        );
      }
    }
    if (quoteEngine.inferenceTimeout !== undefined && !(quoteEngine.inferenceTimeout > 0)) {
      errors.push(`\`quoteEngine.inferenceTimeout\` must be greater than 0 (got ${quoteEngine.inferenceTimeout}).`);
    }
    if (quoteEngine.maxRetries !== undefined && (!Number.isInteger(quoteEngine.maxRetries) || quoteEngine.maxRetries < 0)) {
      errors.push(`\`quoteEngine.maxRetries\` must be a whole number, 0 or greater (got ${quoteEngine.maxRetries}).`);
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
    errors.push('Local mode needs a `local.privateTopic` to isolate this cluster. Run `diiisco setup --local` to generate one.');
  }

  return errors;
}
