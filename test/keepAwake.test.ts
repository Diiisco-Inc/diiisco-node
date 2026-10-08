/**
 * The sleep inhibitor (`src/utils/keepAwake.ts`).
 *
 * A node that serves a model has to stay reachable, and a machine that idles
 * into sleep drops off the network. The strategy for each platform is a pure
 * function, so all three are testable from any host; the controller is driven
 * with a fake `spawn`, so nothing here ever really keeps a machine awake.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { basename, dirname } from 'node:path';
import { KeepAwake, chooseStrategy, commandOnPath } from '../src/utils/keepAwake';

const everything = () => true;
const nothing = () => false;

describe('chooseStrategy', () => {
  test('macOS holds an idle-sleep assertion tied to the node, never the display', () => {
    const strategy = chooseStrategy('darwin', 4242, everything)!;
    expect(strategy.command).toBe('caffeinate');
    expect(strategy.args).toEqual(['-i', '-w', '4242']);
    expect(strategy.args).not.toContain('-d');
    expect(strategy.holdsStdin).toBe(false);
  });

  test('Windows holds SetThreadExecutionState from a hidden PowerShell that ends with its stdin', () => {
    const strategy = chooseStrategy('win32', 1, everything)!;
    expect(strategy.command).toBe('powershell.exe');
    expect(strategy.holdsStdin).toBe(true);
    expect(strategy.args).toContain('-EncodedCommand');
    const encoded = strategy.args[strategy.args.indexOf('-EncodedCommand') + 1];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, then block until the node closes the pipe.
    expect(script).toContain('SetThreadExecutionState(0x80000001)');
    expect(script).toContain('ReadToEnd');
  });

  test('Linux holds a systemd sleep+idle inhibitor that ends with its stdin', () => {
    const strategy = chooseStrategy('linux', 1, everything)!;
    expect(strategy.command).toBe('systemd-inhibit');
    expect(strategy.args).toContain('--what=idle:sleep');
    expect(strategy.args.at(-1)).toBe('cat');
    expect(strategy.holdsStdin).toBe(true);
  });

  test('no helper installed, or an unsupported platform, means no strategy', () => {
    expect(chooseStrategy('darwin', 1, nothing)).toBeNull();
    expect(chooseStrategy('win32', 1, nothing)).toBeNull();
    expect(chooseStrategy('linux', 1, nothing)).toBeNull();
    expect(chooseStrategy('freebsd', 1, everything)).toBeNull();
  });
});

describe('commandOnPath', () => {
  test('finds a command in PATH and not one that is absent', () => {
    const dir = dirname(process.execPath);
    const name = basename(process.execPath);

    expect(commandOnPath(name, { PATH: dir }, process.platform)).toBe(true);
    expect(commandOnPath('definitely-not-a-real-command-xyz', { PATH: dir }, process.platform)).toBe(false);
    expect(commandOnPath(name, {}, process.platform)).toBe(false);
  });
});

/** A child process stand-in that records what was done to it. */
function fakeSpawn() {
  const spawned: Array<{ command: string; args: string[]; options: any; child: any }> = [];
  const spawn = ((command: string, args: string[], options: any) => {
    const child: any = new EventEmitter();
    child.killed = false;
    child.stdinEnded = false;
    child.stdin = { end: () => { child.stdinEnded = true; }, on: () => {}, unref: () => {} };
    child.unref = () => {};
    child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM'); };
    spawned.push({ command, args, options, child });
    return child;
  }) as any;
  return { spawn, spawned };
}

const keepAwake = (spawn: any, options: Record<string, unknown> = {}) =>
  new KeepAwake({ platform: 'darwin', pid: 99, available: everything, spawn, ...options });

describe('KeepAwake', () => {
  test('start spawns the helper once, hidden, and is idempotent', () => {
    const { spawn, spawned } = fakeSpawn();
    const k = keepAwake(spawn);

    expect(k.start()).toBe(true);
    expect(k.start()).toBe(true);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe('caffeinate');
    expect(spawned[0].args).toEqual(['-i', '-w', '99']);
    expect(spawned[0].options.windowsHide).toBe(true);
    expect(k.active).toBe(true);
  });

  test('stop releases the assertion, and can be called again or before start', () => {
    const { spawn, spawned } = fakeSpawn();
    const k = keepAwake(spawn);
    k.stop(); // nothing to stop

    k.start();
    k.stop();
    k.stop();

    expect(spawned[0].child.killed).toBe(true);
    expect(spawned[0].child.stdinEnded).toBe(true);
    expect(k.active).toBe(false);
  });

  test('can be started again after being stopped', () => {
    const { spawn, spawned } = fakeSpawn();
    const k = keepAwake(spawn);

    k.start();
    k.stop();
    expect(k.start()).toBe(true);

    expect(spawned).toHaveLength(2);
  });

  test('a platform with no way to stay awake starts nothing and does not throw', () => {
    const { spawn, spawned } = fakeSpawn();
    const k = keepAwake(spawn, { platform: 'freebsd' });

    expect(k.start()).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(k.active).toBe(false);
  });

  test('a spawn that throws leaves the node running, just not holding anything', () => {
    const k = keepAwake(() => { throw new Error('EACCES'); });

    expect(() => k.start()).not.toThrow();
    expect(k.active).toBe(false);
  });

  test('a helper that dies is restarted, within a budget', async () => {
    const { spawn, spawned } = fakeSpawn();
    const k = keepAwake(spawn, { restartDelaysMs: [5, 5] });
    k.start();

    spawned[0].child.emit('exit', 1, null);
    await Bun.sleep(30);
    expect(spawned).toHaveLength(2);
    expect(k.active).toBe(true);

    spawned[1].child.emit('exit', 1, null);
    await Bun.sleep(30);
    expect(spawned).toHaveLength(3);

    // Budget spent: the third death is not restarted.
    spawned[2].child.emit('exit', 1, null);
    await Bun.sleep(30);
    expect(spawned).toHaveLength(3);
    expect(k.active).toBe(false);
    k.stop();
  });

  test('stopping cancels a pending restart', async () => {
    const { spawn, spawned } = fakeSpawn();
    const k = keepAwake(spawn, { restartDelaysMs: [10] });
    k.start();

    spawned[0].child.emit('exit', 1, null);
    k.stop();
    await Bun.sleep(40);

    expect(spawned).toHaveLength(1);
  });

  test('an asynchronous spawn error (helper vanished) is absorbed', () => {
    const { spawn, spawned } = fakeSpawn();
    const k = keepAwake(spawn);
    k.start();

    expect(() => spawned[0].child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    expect(k.active).toBe(false);
  });
});
