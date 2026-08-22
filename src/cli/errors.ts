/**
 * The CLI's one user-facing error type.
 *
 * It lives in its own module so that modules the config loader depends on
 * (`keystore.ts`) can throw it without an import cycle back through
 * `config.ts`. `config.ts` re-exports it, so `import { ConfigError } from
 * '../config'` keeps working and `err instanceof ConfigError` in `src/cli.ts`
 * still matches — it is the same class object either way.
 */
export class ConfigError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.hints = hints;
  }
}
