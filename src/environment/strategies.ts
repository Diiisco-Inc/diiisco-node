import { QuoteCreationFunction, QuoteSelectionFunction } from '../types/quotes';
import { selectCheapestQuote, selectFastestQuote, selectHighestStakeQuote } from '../utils/quoteSelectionMethods';
import { createStandardQuote } from '../utils/quoteCreationMethods';
import { EnvironmentFile, Environment, QuoteEngineConfig } from './environment.types';

/**
 * `quoteEngine.quoteSelectionFunction` and `quoteCreationFunction` are typed as
 * functions, which JSON cannot express. In `diiisco.config.json` they are
 * written as **strategy names** and resolved here on load, so the config file
 * stays plain JSON while programmatic `configureEnvironment()` callers keep
 * passing real functions.
 */
export const QUOTE_SELECTION_STRATEGIES: Record<string, QuoteSelectionFunction> = {
  selectHighestStakeQuote,
  selectCheapestQuote,
  selectFastestQuote,
};

export const QUOTE_CREATION_STRATEGIES: Record<string, QuoteCreationFunction> = {
  createStandardQuote,
};

export class StrategyError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = 'StrategyError';
    this.hints = hints;
  }
}

export function quoteSelectionStrategyNames(): string[] {
  return Object.keys(QUOTE_SELECTION_STRATEGIES);
}

export function quoteCreationStrategyNames(): string[] {
  return Object.keys(QUOTE_CREATION_STRATEGIES);
}

function resolveSelection(name: string): QuoteSelectionFunction {
  const fn = QUOTE_SELECTION_STRATEGIES[name];
  if (!fn) {
    throw new StrategyError(`Unknown quote selection strategy "${name}".`, [
      `Valid names: ${quoteSelectionStrategyNames().join(', ')}`,
    ]);
  }
  return fn;
}

function resolveCreation(name: string): QuoteCreationFunction {
  const fn = QUOTE_CREATION_STRATEGIES[name];
  if (!fn) {
    throw new StrategyError(`Unknown quote creation strategy "${name}".`, [
      `Valid names: ${quoteCreationStrategyNames().join(', ')}`,
    ]);
  }
  return fn;
}

/**
 * Turn the JSON-side form of a config (strategy names) into the runtime form
 * (functions). Values that are already functions pass through untouched, so a
 * `Partial<Environment>` from a library caller is accepted as-is.
 *
 * Throws `StrategyError` — which lists the valid names — on an unknown name.
 */
export function resolveStrategies(file: EnvironmentFile): Partial<Environment> {
  const { quoteEngine, ...rest } = file;
  if (!quoteEngine) return rest as Partial<Environment>;

  const resolved: Partial<QuoteEngineConfig> = { ...quoteEngine } as Partial<QuoteEngineConfig>;
  const selection = quoteEngine.quoteSelectionFunction;
  const creation = quoteEngine.quoteCreationFunction;

  if (selection !== undefined) {
    if (typeof selection === 'string') {
      resolved.quoteSelectionFunction = resolveSelection(selection);
    } else if (Array.isArray(selection)) {
      resolved.quoteSelectionFunction = selection.map((entry) =>
        typeof entry === 'string' ? resolveSelection(entry) : entry
      );
    } else {
      resolved.quoteSelectionFunction = selection;
    }
  }

  if (creation !== undefined) {
    resolved.quoteCreationFunction = typeof creation === 'string' ? resolveCreation(creation) : creation;
  }

  return { ...rest, quoteEngine: resolved as QuoteEngineConfig } as Partial<Environment>;
}

/**
 * The inverse: render a resolved config back into its JSON form, so
 * `config show --json` and `setup --print` emit something that is itself a
 * valid config file. An unrecognised function falls back to its own `name`,
 * which is what a user would have to add to the strategy tables anyway.
 */
export function strategyName(fn: unknown): string | null {
  if (typeof fn !== 'function') return null;
  for (const [name, candidate] of Object.entries(QUOTE_SELECTION_STRATEGIES)) {
    if (candidate === fn) return name;
  }
  for (const [name, candidate] of Object.entries(QUOTE_CREATION_STRATEGIES)) {
    if (candidate === fn) return name;
  }
  const own = (fn as { name?: string }).name;
  return own && own !== '' ? own : null;
}
