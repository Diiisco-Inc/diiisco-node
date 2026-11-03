/**
 * `diiisco peers` — who the running node is connected to, and `--reconnect` to
 * make it redial now.
 *
 * Both go through the daemon's loopback control channel (`../control.ts`), so
 * they work whether or not the HTTP API is enabled, and a node that has lost
 * its peers can be nudged back without a restart.
 */
import { liveDaemon } from '../daemon';
import { requestPeers, requestReconnect } from '../control';
import { colour, die, info, json, setQuiet, success, warn } from '../output';
import type { PeerReport } from '../../libp2p/peerReport';

export interface PeersOptions {
  json: boolean;
  reconnect: boolean;
}

function printReport(report: PeerReport): void {
  const relayed = report.relayedOnly > 0 ? `, ${report.relayedOnly} through a relay only` : '';
  const bootstrap = report.bootstrapTotal > 0 ? `  bootstrap ${report.bootstrapConnected}/${report.bootstrapTotal}` : '';
  info(`${colour.bold(String(report.connected))} peer(s) connected (${report.direct} direct${relayed}), aiming for ${report.target}${bootstrap}`);
  for (const peer of report.peers) {
    const kind = peer.relayedOnly ? colour.yellow('relayed') : 'direct ';
    info(`  ${peer.peerId.slice(0, 20)}…  ${kind}${peer.bootstrap ? colour.dim('  bootstrap') : ''}`);
  }
  if (report.connected === 0) info(colour.dim('  no peers — try `diiisco peers --reconnect`'));
}

export async function runPeers(options: PeersOptions): Promise<void> {
  if (options.json) setQuiet(true);

  const { state } = liveDaemon();
  if (!state && options.json) {
    json({ ok: false, error: 'the node is not running' });
    process.exitCode = 1;
    return;
  }
  if (!state) die('The node is not running.', 'Start it with: diiisco start');
  if (!state.control) {
    if (options.json) {
      json({ ok: false, error: 'this daemon did not record a control channel; restart it' });
      process.exitCode = 1;
      return;
    }
    die(
      'This daemon did not record a control channel, so it cannot be asked about its peers.',
      'Restart it with: diiisco restart',
    );
  }

  if (options.reconnect) {
    if (!options.json) info(colour.dim('Asking the node to redial its peers…'));
    const answer = await requestReconnect(state.control.port, state.control.token);
    if (!answer.ok || !answer.value) {
      if (options.json) json({ ok: false, error: answer.error });
      else warn(answer.error ?? 'the node did not answer');
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      json({ ok: true, ...answer.value });
      return;
    }
    const { before, after, report } = answer.value;
    success(`Reconnect finished: ${before} → ${after} peer(s) connected`);
    printReport(report);
    return;
  }

  const answer = await requestPeers(state.control.port, state.control.token);
  if (!answer.ok || !answer.value) {
    if (options.json) json({ ok: false, error: answer.error });
    else warn(answer.error ?? 'the node did not answer');
    process.exitCode = 1;
    return;
  }
  if (options.json) json({ ok: true, ...answer.value });
  else printReport(answer.value);
}
