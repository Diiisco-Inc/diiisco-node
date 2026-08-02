import { mkdirSync } from 'node:fs';
import { Application, configureEnvironment } from '../../index';
import { assertValid, loadConfig, requireConfig } from '../config';
import { ensureHome, expandTilde, logFile } from '../paths';
import { startLogRotationWatcher } from '../daemon';
import { colour, error, info } from '../output';

/**
 * Run the node in the foreground. This is also the body of the daemon: `start`
 * re-spawns the executable with the internal `__daemon` argument, which lands
 * here with `daemon: true`.
 */
export async function runServe(options: { daemon?: boolean } = {}): Promise<void> {
  // No implicit zero-config run: a node without a configured backend, an API
  // key and (on the public network) a wallet starts but serves nothing.
  requireConfig();
  ensureHome();

  const env = loadConfig();

  // The peer-id store must exist before libp2p starts, or the node fails deep
  // inside PeerIdManager with "Directory does not exist".
  try {
    mkdirSync(expandTilde(env.peerIdStorage.path), { recursive: true });
  } catch (err: any) {
    error(`Could not create the peer identity directory "${env.peerIdStorage.path}": ${err?.message ?? err}`);
    process.exit(1);
  }

  assertValid(env);
  configureEnvironment(env);

  if (options.daemon) startLogRotationWatcher();

  const app = new Application();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app.shutdown(signal);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  info(`${colour.cyan('▸')} DIIISCO node starting — API on http://localhost:${env.api.port}`);
  if (!options.daemon) info(colour.dim('  Press Ctrl-C to stop. Logs are printed below.'));
  else info(colour.dim(`  Logging to ${logFile()}`));

  await app.start();
}
