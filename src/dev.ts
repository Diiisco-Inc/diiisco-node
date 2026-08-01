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
 * the node simply starts on the committed defaults.
 *
 * `src/cli.ts` must never import this module: the CLI's config comes from
 * `~/.diiisco/config.json`, not from a file inside the source tree.
 */
import { Application, configureEnvironment } from './index';
import type { Environment } from './environment/environment.types';
import { logger } from './utils/logger';

// Assembled at runtime so bundlers cannot statically resolve (and therefore
// cannot fail on) the gitignored module.
const LOCAL_ENVIRONMENT_MODULE = ['.', 'environment', 'environment'].join('/');

async function main(): Promise<void> {
  try {
    const local = await import(/* @vite-ignore */ LOCAL_ENVIRONMENT_MODULE) as { default?: Partial<Environment> };
    if (local?.default) {
      configureEnvironment(local.default);
      logger.info('⚙️  Applied local src/environment/environment.ts override');
    }
  } catch {
    // No local override — run on the committed defaults.
  }

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
