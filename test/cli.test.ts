/**
 * Command-surface smoke tests against the compiled binary (spec §6.3).
 *
 * These are the checks that must pass on every OS in the matrix: the binary
 * runs at all, reports its baked-in version, and gets the "not configured"
 * contract right — exit 2, distinct from a failure, so a script can tell the
 * two apart.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import algosdk from 'algosdk';
import { NO_BINARY_REASON, binary, makeHome, removeHome, run } from './helpers';

const suite = binary ? describe : describe.skip;
if (!binary) console.warn(`skipping cli.test.ts: ${NO_BINARY_REASON}`);

suite('compiled binary — command surface', () => {
  const home = makeHome('diiisco-cli-');
  afterAll(() => removeHome(home));

  test('version prints the injected version and install source', () => {
    const result = run(['version'], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^diiisco \d+\.\d+\.\d+/);
    // --define bakes DIIISCO_INSTALL_SOURCE in; an un-injected build would say
    // "source" and the desktop update hint (§9.4) would point at the wrong place.
    expect(result.stdout).toMatch(/\[(standalone|desktop-bundled)\]/);
  });

  test('the desktop-bundled variant reports its own install source (§9.4)', () => {
    // Built by `bun run build:binaries:desktop`. Only its provenance differs
    // from the standalone artifact, and getting it wrong sends desktop users to
    // install.sh for updates instead of the app's own updater.
    const desktop = binary ? join(dirname(binary), 'desktop', binary.split('/').pop()!) : null;
    if (!desktop || !existsSync(desktop)) {
      console.warn('skipping the desktop-variant check: run `bun run build:binaries:desktop` to cover it');
      return;
    }

    const result = spawnSync(desktop, ['version'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[desktop-bundled]');
  });

  test('help lists the documented commands', () => {
    const result = run(['help'], { home });
    expect(result.code).toBe(0);
    for (const command of ['setup', 'start', 'stop', 'restart', 'status', 'logs', 'serve', 'launch', 'config']) {
      expect(result.stdout).toContain(command);
    }
  });

  test('an unknown command fails with a pointer to help', () => {
    const result = run(['definitely-not-a-command'], { home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('diiisco help');
  });

  test('launch --list --json emits the desktop-facing contract', () => {
    const result = run(['launch', '--list', '--json'], { home });
    expect(result.code).toBe(0);

    const listing = JSON.parse(result.stdout);
    expect(Array.isArray(listing)).toBe(true);
    expect(listing.length).toBeGreaterThan(0);

    for (const entry of listing) {
      expect(typeof entry.app).toBe('string');
      expect(typeof entry.bin).toBe('string');
      expect(['anthropic', 'openai']).toContain(entry.wire);
      expect(typeof entry.installed).toBe('boolean');
      expect(typeof entry.installHint).toBe('string');
      expect(typeof entry.defaultModelWiring).toBe('boolean');
    }

    expect(listing.map((e: { app: string }) => e.app)).toContain('claude');
    const claude = listing.find((e: { app: string }) => e.app === 'claude');
    expect(claude.defaultModelWiring).toBe(true);
  });

  test('launch --list works with no config file', () => {
    // §3.3: --list must not be gated on configuration.
    const empty = makeHome('diiisco-cli-empty-');
    try {
      const result = run(['launch', '--list'], { home: empty });
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('No DIIISCO configuration found');
    } finally {
      removeHome(empty);
    }
  });

  test('config path answers without a config file', () => {
    const empty = makeHome('diiisco-cli-path-');
    try {
      const result = run(['config', 'path'], { home: empty });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('diiisco.config.json');
    } finally {
      removeHome(empty);
    }
  });

  test('config path --key answers without a config file too', () => {
    // The desktop app asks the binary where the wallet key lives rather than
    // re-deriving the DIIISCO_HOME / DIIISCO_CONFIG precedence itself, and it
    // asks before the machine is set up.
    const empty = makeHome('diiisco-cli-keypath-');
    try {
      const result = run(['config', 'path', '--key'], { home: empty });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(join(empty, 'algorand-key.json'));
    } finally {
      removeHome(empty);
    }
  });

  test('two different wallet keys stop `start` before it spawns anything', () => {
    // The wallet key belongs in algorand-key.json. When the config still names
    // a *different* wallet, choosing either one would silently change which
    // account is spending — so the node refuses, in the foreground, and leaves
    // both files for the user to reconcile.
    const home = makeHome('diiisco-cli-conflict-');
    try {
      const alice = algosdk.generateAccount();
      const bob = algosdk.generateAccount();
      const configFile = join(home, 'diiisco.config.json');
      const keyFile = join(home, 'algorand-key.json');

      writeFileSync(
        configFile,
        JSON.stringify({
          models: { enabled: false, baseURL: 'http://localhost', port: 11434, apiKey: '' },
          api: { enabled: true, bearerAuthentication: false, keys: ['diiisco'], port: 8099 },
          libp2pBootstrapServers: [],
          algorand: {
            mnemonic: algosdk.secretKeyToMnemonic(bob.sk),
            network: 'testnet',
            client: { address: 'https://testnet-api.algonode.cloud/', port: 443, token: '' },
            settlement: { methods: ['x402'], maxSpend: 0.1 },
          },
        }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
      writeFileSync(
        keyFile,
        JSON.stringify({
          version: 1,
          mnemonic: algosdk.secretKeyToMnemonic(alice.sk),
          address: alice.addr.toString(),
          updatedAt: new Date().toISOString(),
        }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );

      const configBefore = readFileSync(configFile, 'utf8');
      const keyBefore = readFileSync(keyFile, 'utf8');

      const result = run(['start'], { home, timeoutMs: 30_000 });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Two different Algorand wallets are configured');
      expect(result.stderr).toContain(alice.addr.toString());
      expect(result.stderr).toContain(bob.addr.toString());

      // No daemon, and neither file touched.
      expect(existsSync(join(home, 'daemon.json'))).toBe(false);
      expect(readFileSync(configFile, 'utf8')).toBe(configBefore);
      expect(readFileSync(keyFile, 'utf8')).toBe(keyBefore);
    } finally {
      removeHome(home);
    }
  });

  describe('the not-configured gate (§3.3)', () => {
    for (const command of ['start', 'restart', 'serve']) {
      test(`${command} exits 2 and names the wizard`, () => {
        const empty = makeHome('diiisco-cli-unconfigured-');
        try {
          const result = run([command], { home: empty, timeoutMs: 30_000 });
          expect(result.code).toBe(2);
          expect(result.stderr).toContain('No DIIISCO configuration found');
          expect(result.stderr).toContain('diiisco setup');
        } finally {
          removeHome(empty);
        }
      });
    }

    test('status reports configured:false rather than erroring', () => {
      const empty = makeHome('diiisco-cli-status-');
      try {
        const result = run(['status', '--json'], { home: empty });
        const report = JSON.parse(result.stdout);
        expect(report.configured).toBe(false);
        expect(report.running).toBe(false);
        expect(report.configPath).toContain('diiisco.config.json');
      } finally {
        removeHome(empty);
      }
    });
  });

  test('setup --local --yes --print writes nothing and emits a usable config', () => {
    const empty = makeHome('diiisco-cli-print-');
    try {
      const result = run(['setup', '--local', '--yes', '--print'], { home: empty });
      expect(result.code).toBe(0);

      const config = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      expect(config.local.enabled).toBe(true);
      expect(typeof config.local.privateTopic).toBe('string');
      expect(config.algorand).toBeUndefined();

      // --print must not create the file.
      const after = run(['status', '--json'], { home: empty });
      expect(JSON.parse(after.stdout).configured).toBe(false);

      // Local mode has no wallet, so there is nothing to write a key file for.
      expect(existsSync(join(empty, 'algorand-key.json'))).toBe(false);
    } finally {
      removeHome(empty);
    }
  });

  test('setup --public writes the wallet key to its own file, not the config', () => {
    const home = makeHome('diiisco-cli-setup-public-');
    try {
      const account = algosdk.generateAccount();
      const result = run(
        ['setup', '--public', '--yes', '--network', 'testnet', '--max-spend', '0.05', '--mnemonic-stdin'],
        { home, input: `${algosdk.secretKeyToMnemonic(account.sk)}\n`, timeoutMs: 30_000 }
      );
      expect(result.code).toBe(0);

      const key = JSON.parse(readFileSync(join(home, 'algorand-key.json'), 'utf8'));
      expect(key.address).toBe(account.addr.toString());

      const config = JSON.parse(readFileSync(join(home, 'diiisco.config.json'), 'utf8'));
      expect(config.algorand.mnemonic).toBeUndefined();
      expect(config.algorand.network).toBe('testnet');

      // And the effective view still resolves a wallet — redacted.
      const shown = JSON.parse(run(['config', 'show', '--json'], { home }).stdout);
      expect(shown.algorand.mnemonic).toBe('<redacted>');
    } finally {
      removeHome(home);
    }
  });
});
