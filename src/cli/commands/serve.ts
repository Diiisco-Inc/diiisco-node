import { Application, configureEnvironment } from '../../index';
import { assertValid, isFirstRun, loadConfig, markFirstRunSeen } from '../config';
import { ensureHome, expandTilde, diiiscoHome, logFile } from '../paths';
import { startLogRotationWatcher } from '../daemon';
import { colour, error, info } from '../output';
import { mkdirSync } from 'node:fs';

/**
 * Run the node in the foreground. This is also the body of the daemon: `start`
 * re-spawns the executable with the internal `__daemon` argument, which lands
 * here with `daemon: true`.
 */
export async function runServe(options: { daemon?: boolean } = {}): Promise<void> {
  ensureHome();

  const firstRun = isFirstRun();
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

  if (firstRun) {
    printFirstRunNotice();
    markFirstRunSeen();
  }

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

function printFirstRunNotice(): void {
  info();
  info(colour.bold('Welcome to DIIISCO.'));
  info(`No config found at ${diiiscoHome()}/config.json, so this node is running in ${colour.bold('local mode')}:`);
  info('  • payment-free, using an ephemeral signing key');
  info('  • it serves models from your local inference server and does not join the public network');
  info('');
  info(`To join the public network and earn USDC, run ${colour.cyan('diiisco config init --public')}.`);
  info('');
}
