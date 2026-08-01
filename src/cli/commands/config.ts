import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Environment } from '../../environment/environment.types';
import {
  generatePrivateTopic,
  loadConfig,
  readConfigFile,
  redactConfig,
  writeConfigFile,
} from '../config';
import { validateEnvironment } from '../../environment/validate';
import { configPath } from '../paths';
import { colour, die, info, json, print, setQuiet, success, warn } from '../output';

export type ConfigMode = 'local' | 'public';

export interface ConfigOptions {
  subcommand: string | undefined;
  mode: ConfigMode | undefined;
  asJson: boolean;
  force: boolean;
}

export async function runConfig(options: ConfigOptions): Promise<void> {
  switch (options.subcommand) {
    case 'path':
      return runConfigPath();
    case 'show':
      return runConfigShow(options.asJson);
    case 'init':
      return runConfigInit(options.mode, options.force);
    case undefined:
      die('Usage: diiisco config init|show|path');
      break;
    default:
      die(`Unknown config subcommand "${options.subcommand}".`, 'Usage: diiisco config init|show|path');
  }
}

function runConfigPath(): void {
  print(configPath());
}

function runConfigShow(asJson: boolean): void {
  if (asJson) setQuiet(true);
  const env = loadConfig();
  const redacted = redactConfig(env);

  if (asJson) {
    json(redacted);
    return;
  }

  const exists = existsSync(configPath());
  info(colour.bold('Effective configuration'));
  info(colour.dim(`  defaults ${exists ? `+ ${configPath()}` : '(no config file — local mode)'}`));
  info('');
  print(JSON.stringify(redacted, null, 2));

  const problems = validateEnvironment(env);
  if (problems.length > 0) {
    info('');
    warn('This configuration will not start:');
    for (const problem of problems) info(`  • ${problem}`);
  }
}

async function runConfigInit(mode: ConfigMode | undefined, force: boolean): Promise<void> {
  const path = configPath();
  if (existsSync(path) && !force) {
    die(
      `${path} already exists.`,
      'Re-run with --force to overwrite it, or edit it directly.',
      'See what is in effect with `diiisco config show`.'
    );
  }

  const chosen = mode ?? (await askMode());
  const existing = force ? {} : (readConfigFile() ?? {});

  const config: Partial<Environment> =
    chosen === 'local' ? buildLocalConfig(existing) : await buildPublicConfig(existing);

  writeConfigFile(config);
  success(`Wrote ${path} (mode 0600).`);
  info('');
  if (chosen === 'local') {
    info('This node runs payment-free on a private topic, against your local inference server.');
    info(`Next: ${colour.cyan('diiisco launch claude')}`);
  } else {
    info('This node will join the public DIIISCO network and settle in USDC over x402.');
    info(`Next: ${colour.cyan('diiisco start')} then ${colour.cyan('diiisco status')}`);
  }
}

function buildLocalConfig(existing: Partial<Environment>): Partial<Environment> {
  return {
    ...existing,
    local: {
      enabled: true,
      privateTopic: existing.local?.privateTopic ?? generatePrivateTopic(),
    },
  };
}

async function buildPublicConfig(existing: Partial<Environment>): Promise<Partial<Environment>> {
  if (!process.stdin.isTTY) {
    die(
      'Public mode needs a wallet mnemonic, and stdin is not a terminal.',
      `Write the \`algorand\` block into ${configPath()} by hand, or run this command interactively.`
    );
  }

  info(colour.bold('Joining the public DIIISCO network'));
  info(colour.dim('  Your mnemonic is stored in ~/.diiisco/config.json with mode 0600 and never leaves this machine.'));
  info('');

  let network: string;
  let algod: string;
  let nfd: string;
  let maxSpend: number;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    network = (await ask(rl, 'Network (mainnet/testnet)', existing.algorand?.network ?? 'mainnet')).toLowerCase();
    if (network !== 'mainnet' && network !== 'testnet') {
      die(`Unknown network "${network}". Use mainnet or testnet.`);
    }

    const defaultAlgod = network === 'mainnet'
      ? 'https://mainnet-api.algonode.cloud/'
      : 'https://testnet-api.algonode.cloud/';
    algod = await ask(rl, 'Algod URL', existing.algorand?.client?.address ?? defaultAlgod);
    nfd = (await ask(rl, 'NFD name (optional, e.g. my-node.diiisco.algo)', existing.algorand?.nfd ?? '')).trim();

    const maxSpendRaw = await ask(rl, 'Max spend per request in USDC', String(existing.algorand?.settlement?.maxSpend ?? 0.1));
    maxSpend = Number(maxSpendRaw);
    if (!Number.isFinite(maxSpend) || maxSpend <= 0) die(`"${maxSpendRaw}" is not a positive number of USDC.`);
  } finally {
    // Close the readline interface before reading the mnemonic: it is a
    // spending key, so it is read with echo off and must not be captured by
    // readline's history either.
    rl.close();
  }

  const mnemonic = (await askSecret('25-word wallet mnemonic (input hidden): ')).trim();
  if (mnemonic === '') {
    die('A mnemonic is required for public mode.', 'Run `diiisco config init --local` for a payment-free node instead.');
  }
  if (mnemonic.split(/\s+/).length !== 25) {
    warn('That does not look like a 25-word mnemonic — writing it anyway; `diiisco status` will tell you if the wallet fails to load.');
  }

  const config: Partial<Environment> = {
    ...existing,
    local: { enabled: false },
    algorand: {
      mnemonic,
      network: network as 'mainnet' | 'testnet',
      client: { address: algod, port: 443, token: '' },
      settlement: {
        methods: ['x402'],
        maxSpend,
        x402: { selfSubmitFallback: true },
      },
    },
  };
  if (nfd !== '') config.algorand!.nfd = nfd;
  return config;
}

/** Read a line from the terminal without echoing it. */
function askSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;

  return new Promise<string>((resolve, reject) => {
    output.write(prompt);
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';
    const finish = (fn: () => void) => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write('\n');
      fn();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(value));
        if (ch === '\u0003') return finish(() => reject(new Error('Cancelled.')));
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    input.on('data', onData);
  });
}

async function askMode(): Promise<ConfigMode> {
  if (!process.stdin.isTTY) {
    die('Specify a mode: `diiisco config init --local` or `diiisco config init --public`.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await ask(rl, 'Mode — [l]ocal (payment-free) or [p]ublic (earn USDC)', 'l')).toLowerCase();
    if (answer.startsWith('p')) return 'public';
    if (answer.startsWith('l')) return 'local';
    die(`Unknown mode "${answer}". Use --local or --public.`);
  } finally {
    rl.close();
  }
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string, fallback: string): Promise<string> {
  const suffix = fallback === '' ? '' : ` [${fallback}]`;
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer === '' ? fallback : answer;
}
