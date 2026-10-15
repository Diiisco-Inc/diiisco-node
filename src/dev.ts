/**
 * Developer / PM2 entry point.
 *
 * `src/index.ts` is a pure library export and the `diiisco` binary starts the
 * node through `src/cli.ts`. This module preserves the original repo workflow:
 * a contributor keeps a hand-edited, gitignored `src/environment/environment.ts`
 * and runs the built bundle directly (`node dist/dev.js`, or under PM2).
 *
 * The local override is loaded through a *dynamic* import with a non-literal
 * specifier so that a checkout without that file — CI, a fresh clone, or the
 * compiled binary — neither fails to build nor fails to run. When it is absent
 * the node simply starts on the committed defaults. The specifier carries a
 * `.js` extension because the package is ESM and Node does not resolve
 * extensionless relative imports (Bun maps `.js` to the `.ts` source, and the
 * build compiles the override to `dist/environment/environment.js`).
 *
 * Only "the override file is not there" is treated as absence. A file that is
 * present but throws is a broken config, and carrying on with half of it
 * applied ends in a confusing crash later, so that stops the node.
 *
 * `src/cli.ts` must never import this module: the CLI's config comes from
 * `~/.diiisco/config.json`, not from a file inside the source tree.
 */
import { Application, configureEnvironment } from './index';
import type { Environment } from './environment/environment.types';
import runtime from './environment/runtime';
import { logger } from './utils/logger';
import { installProcessGuards } from './utils/processGuards';

// Assembled at runtime so bundlers cannot statically resolve (and therefore
// cannot fail on) the gitignored module.
const LOCAL_ENVIRONMENT_MODULE = ['.', 'environment', 'environment.js'].join('/');

/**
 * True when the import failed because the override file itself is missing — not
 * because the override exists and one of *its* imports is missing, which names
 * a different module first in the message.
 */
function isOverrideMissing(err: any): boolean {
  const message = String(err?.message ?? '');
  if (err?.code !== 'ERR_MODULE_NOT_FOUND' && !message.startsWith('Cannot find module')) return false;
  const missing = /^Cannot find (?:module|package) '([^']+)'/.exec(message)?.[1];
  return missing !== undefined && /environment[\\/]environment(\.\w+)?$/.test(missing);
}

/**
 * The committed defaults carry neither an `algorand` block nor local mode, so a
 * checkout with no override would otherwise die inside `new Application()` on
 * `Cannot read properties of undefined (reading 'mnemonic')`. Say what is
 * missing instead.
 */
function requireWalletOrLocalMode(): void {
  if (runtime.local?.enabled === true || runtime.algorand) return;
  logger.error(
    '🚨  Nothing to run on: no local src/environment/environment.ts override was applied, and the defaults ' +
      'have neither an `algorand` wallet nor `local.enabled`. Copy src/environment/example.environment.ts to ' +
      'src/environment/environment.ts and configure a wallet (public network) or `local: { enabled: true, privateTopic }`, ' +
      'then rebuild. To run the packaged node instead, use `diiisco setup` and `diiisco start`.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  // Before anything opens a socket: an aborted dial must not take the node down.
  installProcessGuards();

  try {
    const specifier = new URL(LOCAL_ENVIRONMENT_MODULE, import.meta.url).href;
    const local = await import(/* @vite-ignore */ specifier) as { default?: Partial<Environment> };
    if (local?.default) {
      configureEnvironment(local.default);
      logger.info('⚙️  Applied local src/environment/environment.ts override');
    }
  } catch (err: any) {
    if (!isOverrideMissing(err)) {
      logger.error('🚨  Failed to load the local src/environment/environment.ts override:', err);
      process.exit(1);
    }
    // No local override — run on the committed defaults.
  }

  requireWalletOrLocalMode();

  const app = new Application();
  process.on('SIGTERM', () => app.shutdown('SIGTERM'));
  process.on('SIGINT', () => app.shutdown('SIGINT'));

  try {
    await app.start();
  } catch (err: any) {
    if (err?.message === 'PeerID not found.') {
      logger.error('🚨  Application failed to start: PeerID not found.');
    } else {
      logger.error('🚨  Application failed to start:', err);
    }
    process.exit(1);
  }
}

void main();
