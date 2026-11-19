/**
 * `stop` must not signal a pid it cannot show is the daemon (review pass 2): a
 * daemon that exited without clearing `daemon.json` leaves a pid the OS may have
 * handed to an unrelated process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, makeHome, removeHome } from './helpers';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform === 'win32')('stopDaemon with a recorded pid', () => {
  let home: string;
  let saved: string | undefined;
  let bystander: ChildProcess;

  beforeAll(() => {
    home = makeHome('diiisco-pid-reuse-');
    saved = process.env.DIIISCO_HOME;
    process.env.DIIISCO_HOME = home;
    // An unrelated process that happens to hold the pid the state file names.
    bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
  });
  afterAll(() => {
    bystander.kill('SIGKILL');
    if (saved === undefined) delete process.env.DIIISCO_HOME; else process.env.DIIISCO_HOME = saved;
    removeHome(home);
  });

  test('a refused control port means "not our daemon": the state is cleared and the pid is left alone', async () => {
    const { writeDaemonState, stopDaemon } = await import('../src/cli/daemon');
    const port = await freePort(); // nothing listens on it
    writeDaemonState({
      pid: bystander.pid!, startedAt: new Date().toISOString(), endpoint: 'http://localhost:1', version: 'x', owner: 'cli',
      control: { port, token: 'a'.repeat(64) },
    });

    const result = await stopDaemon(200, 20);

    expect(result.outcome).toBe('stale');
    expect(result.controlError).toContain('nothing is listening');
    expect(alive(bystander.pid!)).toBe(true);
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  });
});
