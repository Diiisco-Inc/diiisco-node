import { mkdirSync } from 'node:fs';
import { Application, configureEnvironment } from '../../index';
import { assertValid, loadConfig, requireConfig } from '../config';
import { ensureHome, expandTilde, logFile } from '../paths';
import { recordControlChannel, startLogRotationWatcher } from '../daemon';
import { ControlServer, generateControlToken, startControlServer } from '../control';
import { colour, error, info, warn } from '../output';

/**
 * If `Application.shutdown()` itself wedges, the process must still go away —
 * otherwise `diiisco stop` escalates to SIGKILL and the user is left with a
 * half-closed node. Generous enough that a healthy shutdown (libp2p stop can
 * take several seconds) always wins the race.
 */
const SHUTDOWN_WATCHDOG_MS = 30_000;

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
  let control: ControlServer | null = null;
  let shuttingDown = false;

  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop accepting control connections first: the instruction has already
    // been acknowledged and a second one would be a no-op anyway.
    control?.close();
    // `Application.shutdown()` exits the process itself on both paths; this is
    // the backstop for a shutdown step that never settles.
    const watchdog = setTimeout(() => {
      error(`Graceful shutdown did not finish within ${SHUTDOWN_WATCHDOG_MS / 1000}s — exiting.`);
      process.exit(1);
    }, SHUTDOWN_WATCHDOG_MS);
    void app.shutdown(reason).catch((err: unknown) => {
      clearTimeout(watchdog);
      error(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // The daemon has no controlling terminal, so a signal is not something a user
  // can send it portably — `diiisco stop` talks to this instead. Started before
  // `app.start()` so a `stop` issued during a slow boot still shuts down
  // cleanly, and never for a foreground `serve`, which the user stops with
  // Ctrl-C and which has no `daemon.json` to publish a token in.
  if (options.daemon) {
    try {
      control = await startControlServer({ token: generateControlToken(), onShutdown: shutdown });
      const recorded = await recordControlChannel({ port: control.port, token: control.token });
      if (!recorded) {
        warn('Could not record the control channel in daemon.json — `diiisco stop` will fall back to signals.');
      }
    } catch (err: any) {
      // A node that cannot open a loopback socket is still a working node;
      // `stop` degrades to the signal path.
      warn(`Could not start the shutdown control channel: ${err?.message ?? err}`);
    }
  }

  info(`${colour.cyan('▸')} DIIISCO node starting — API on http://localhost:${env.api.port}`);
  if (!options.daemon) info(colour.dim('  Press Ctrl-C to stop. Logs are printed below.'));
  else info(colour.dim(`  Logging to ${logFile()}`));

  await app.start();
}
