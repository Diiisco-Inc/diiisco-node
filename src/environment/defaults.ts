import { Environment } from './environment.types';
import { selectHighestStakeQuote } from '../utils/quoteSelectionMethods';
import { deepMerge } from '../utils/deepMerge';

/**
 * Zero-config defaults for a DIIISCO node.
 *
 * Historically every module imported `src/environment/environment.ts` — a
 * gitignored, hand-edited file. A compiled binary cannot depend on a file that
 * is not in the repository, so the committed defaults live here instead and the
 * mutable singleton (`src/environment/runtime.ts`) is initialised from them.
 *
 * These defaults deliberately describe a machine with nothing set up: Ollama on
 * its default port, the HTTP API unauthenticated on :8080, runtime state under
 * `~/.diiisco`, and **no** `algorand` block. A node with no wallet must be run
 * in local mode — see `validateEnvironment()`.
 */
export function createDefaultEnvironment(): Environment {
  return {
    peerIdStorage: {
      path: '~/.diiisco',
    },
    models: {
      enabled: true,
      baseURL: 'http://localhost',
      port: 11434, // Ollama's default port
      apiKey: '',
      chargePer1MTokens: {
        default: 0.01703,
      },
    },
    api: {
      enabled: true,
      bearerAuthentication: false,
      keys: ['diiisco'],
      port: 8080,
      networkWaitTime: 10000,
    },
    quoteEngine: {
      waitTime: 1000,
      preferSelf: true,
      quoteSelectionFunction: selectHighestStakeQuote,
    },
    libp2pBootstrapServers: [
      'lon.diiisco.algo',
      'nyc.diiisco.algo',
    ],
    node: {
      url: 'http://localhost',
      port: 4242,
      displayName: 'DIIISCO Node',
    },
    local: {
      enabled: false,
    },
  };
}

/**
 * The canonical default environment. Prefer `createDefaultEnvironment()` when a
 * fresh, independently mutable copy is needed (the config loader does exactly
 * that, so merging a user's config can never mutate the shared defaults).
 */
export const DEFAULT_ENVIRONMENT: Environment = createDefaultEnvironment();

/**
 * Deep-merge partial config (e.g. `~/.diiisco/config.json`) onto a fresh copy of
 * the defaults. This is loading step 1 + 2 of the configuration model.
 */
export function withDefaults(overrides?: Partial<Environment> | null): Environment {
  const base = createDefaultEnvironment();
  if (!overrides) return base;
  return deepMerge(base, overrides);
}
