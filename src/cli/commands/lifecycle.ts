import { Environment } from '../../environment/environment.types';
import { apiEndpoint, assertValid, configExists, configPath, loadConfig, mergeConfig, requireConfig } from '../config';
import {
  DaemonState,
  liveDaemon,
  probe,
  readDaemonState,
  spawnDaemon,
  stopDaemon,
  waitForHealth,
} from '../daemon';
import { diiiscoHome, logFile } from '../paths';
import { colour, die, info, json, setQuiet, success, warn } from '../output';
import { version } from '../version';

const START_HEALTH_TIMEOUT_MS = 30_000;

export interface StartOptions {
  /** Wait this long for `/health` before giving up (ms). */
  timeoutMs?: number;
  /** Suppress the success/progress chatter (used by `launch`). */
  silent?: boolean;
}

/**
 * Start the node as a detached background daemon and wait for it to answer
 * `/health`. Returns the endpoint it is serving on.
 */
export async function runStart(options: StartOptions = {}): Promise<string> {
  requireConfig();
  const existing = liveDaemon();
  const env = loadConfig();
  const endpoint = apiEndpoint(env);

  if (existing.state) {
    if (!options.silent) {
      info(`DIIISCO node is already running (pid ${existing.state.pid}, started by ${existing.state.owner}).`);
      info(colour.dim(`  ${existing.state.endpoint || endpoint}`));
    }
    return existing.state.endpoint || endpoint;
  }
  if (existing.stale && !options.silent) {
    warn('Removed a stale daemon.json (the recorded process was no longer running).');
  }

  // Something is already bound to the API port — a `diiisco serve` in another
  // terminal, or an unrelated service. Starting anyway would spawn a daemon
  // that fails to bind while `/health` (answered by the other process) makes it
  // look like a success.
  if ((await probe(endpoint, '/health', 2000)).ok) {
    die(
      `${endpoint} is already being served, but not by a daemon this CLI started.`,
      'If that is a `diiisco serve` in another terminal, stop it there.',
      'Otherwise change `api.port` in `diiisco config path`.'
    );
  }

  // Fail here, in the foreground, rather than in a detached process whose only
  // trace is a line in the log file.
  assertValid(env);

  const { pid } = spawnDaemon(endpoint);
  if (!options.silent) info(`Starting DIIISCO node (pid ${pid})…`);

  const healthy = await waitForHealth(endpoint, options.timeoutMs ?? START_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    die(
      `The node did not answer ${endpoint}/health within ${(options.timeoutMs ?? START_HEALTH_TIMEOUT_MS) / 1000}s.`,
      `Check the log: diiisco logs -n 50`,
      `The process (pid ${pid}) may still be starting; run \`diiisco status\` again in a moment.`
    );
  }

  if (!options.silent) {
    success(`DIIISCO node running on ${endpoint} (pid ${pid}).`);
    info(colour.dim(`  logs: ${logFile()}`));
  }
  return endpoint;
}

export async function runStop(): Promise<void> {
  const result = await stopDaemon();
  switch (result.outcome) {
    case 'not-running':
      info('No DIIISCO node is running.');
      return;
    case 'stale':
      warn(`No process with pid ${result.pid} — removed the stale daemon.json.`);
      return;
    case 'stopped':
      success(`Stopped DIIISCO node (pid ${result.pid}).`);
      return;
    case 'killed':
      warn(`DIIISCO node (pid ${result.pid}) did not exit in time and was killed.`);
      return;
  }
}

export async function runRestart(): Promise<void> {
  requireConfig();
  await runStop();
  await runStart();
}

/** The `status --json` shape. This is a contract the desktop app consumes. */
export interface StatusReport {
  /** False when no config file exists — `status` reports it rather than erroring. */
  configured: boolean;
  running: boolean;
  stale: boolean;
  pid: number | null;
  startedAt: string | null;
  uptimeSeconds: number | null;
  endpoint: string;
  version: string | null;
  owner: string | null;
  health: { ok: boolean; status: number | null; error: string | null } | null;
  algorand: AlgorandStatus | null;
  home: string;
  configPath: string;
  logFile: string;
  cliVersion: string;
}

export interface AlgorandStatus {
  ok: boolean;
  status: number | null;
  mode: 'local' | 'public' | 'unknown';
  address: string | null;
  algodReachable: boolean | null;
  algoBalance: string | null;
  dsco: { optedIn: boolean; balance: string } | null;
  usdc: { optedIn: boolean; balance: string } | null;
  error: string | null;
}

export async function collectStatus(): Promise<StatusReport> {
  // `status` must answer on an unconfigured machine, so a config file that is
  // missing (or unreadable) degrades to the defaults rather than throwing.
  const configured = configExists();
  let env: Environment;
  try {
    env = loadConfig();
  } catch {
    env = mergeConfig(null);
  }
  const configuredEndpoint = apiEndpoint(env);
  const recorded = readDaemonState();
  const running = recorded !== null && isRunning(recorded);
  const stale = recorded !== null && !running;
  const endpoint = recorded?.endpoint || configuredEndpoint;

  const report: StatusReport = {
    configured,
    running,
    stale,
    pid: running ? recorded!.pid : null,
    startedAt: running ? recorded!.startedAt : null,
    uptimeSeconds: running ? uptimeSeconds(recorded!.startedAt) : null,
    endpoint,
    version: running ? recorded!.version : null,
    owner: running ? recorded!.owner : null,
    health: null,
    algorand: null,
    home: diiiscoHome(),
    configPath: configPath(),
    logFile: logFile(),
    cliVersion: version(),
  };

  if (!running) return report;

  const health = await probe(endpoint, '/health');
  report.health = { ok: health.ok, status: health.status, error: health.error };
  if (!health.ok) return report;

  report.algorand = await collectAlgorandStatus(endpoint, env.api.bearerAuthentication ? env.api.keys?.[0] : undefined);
  return report;
}

async function collectAlgorandStatus(endpoint: string, key?: string): Promise<AlgorandStatus> {
  const result = await probeAlgorand(endpoint, key);
  const status: AlgorandStatus = {
    ok: result.ok,
    status: result.status,
    mode: 'unknown',
    address: null,
    algodReachable: null,
    algoBalance: null,
    dsco: null,
    usdc: null,
    error: result.error,
  };

  if (!result.body) return status;

  try {
    const body = JSON.parse(result.body);
    status.mode = body.localMode === true ? 'local' : 'public';
    status.address = body.address ?? null;
    status.algodReachable = typeof body.algodReachable === 'boolean' ? body.algodReachable : null;
    status.algoBalance = body.algoBalance ?? null;
    status.dsco = body.dsco ?? null;
    status.usdc = body.usdc ?? null;
    status.error = body.error ?? result.error;
  } catch {
    status.error = status.error ?? 'the node returned a non-JSON /health/algorand response';
  }
  return status;
}

async function probeAlgorand(endpoint: string, key?: string) {
  // `/health/algorand` is behind bearer auth when the node enables it, so send
  // the configured key; without it the answer would be a bare 401.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/health/algorand`, {
      signal: controller.signal,
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    return { ok: response.ok, status: response.status, body: await response.text(), error: null as string | null };
  } catch (err: any) {
    return { ok: false, status: null, body: null, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

function isRunning(state: DaemonState): boolean {
  try {
    process.kill(state.pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function uptimeSeconds(startedAt: string): number | null {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

export async function runStatus(asJson: boolean): Promise<void> {
  if (asJson) setQuiet(true);
  const report = await collectStatus();

  if (asJson) {
    json(report);
    process.exitCode = report.running ? 0 : 1;
    return;
  }

  if (!report.running) {
    info(`${colour.red('●')} DIIISCO node: ${colour.bold('stopped')}`);
    if (report.stale) info(colour.dim('  A stale daemon.json was found — the recorded process is gone.'));
    if (!report.configured) {
      info(`  config    ${colour.yellow('not configured')} — ${report.configPath}`);
      info(colour.dim('  set it up with: diiisco setup'));
    } else {
      info(colour.dim(`  config: ${report.configPath}`));
      info(colour.dim(`  start it with: diiisco start`));
    }
    process.exitCode = 1;
    return;
  }

  const healthy = report.health?.ok === true;
  info(`${healthy ? colour.green('●') : colour.yellow('●')} DIIISCO node: ${colour.bold(healthy ? 'running' : 'running (API not responding)')}`);
  info(`  pid       ${report.pid}`);
  info(`  uptime    ${formatUptime(report.uptimeSeconds)}`);
  info(`  endpoint  ${report.endpoint}`);
  info(`  version   ${report.version}`);
  info(`  owner     ${report.owner}`);
  if (report.health && !report.health.ok) {
    info(`  health    ${colour.yellow(report.health.error ?? `HTTP ${report.health.status}`)}`);
  }

  const algo = report.algorand;
  if (algo) {
    info('');
    if (algo.mode === 'local') {
      info(`  ${colour.bold('Algorand')}  local mode — payments disabled`);
    } else if (algo.mode === 'public') {
      info(`  ${colour.bold('Algorand')}  ${algo.algodReachable ? colour.green('algod reachable') : colour.red('algod unreachable')}`);
      if (algo.address) info(`    address ${algo.address}`);
      if (algo.algoBalance) info(`    balance ${algo.algoBalance}`);
      if (algo.usdc) info(`    USDC    ${algo.usdc.balance}${algo.usdc.optedIn ? '' : colour.yellow(' (not opted in)')}`);
      if (algo.dsco) info(`    DSCO    ${algo.dsco.balance}${algo.dsco.optedIn ? '' : colour.yellow(' (not opted in)')}`);
      if (algo.error) info(`    ${colour.yellow(algo.error)}`);
    } else {
      info(`  ${colour.bold('Algorand')}  ${colour.yellow(algo.error ?? 'unknown')}`);
    }
  }

  info('');
  info(colour.dim(`  logs: ${report.logFile}`));
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
