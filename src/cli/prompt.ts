import { createInterface, Interface } from 'node:readline/promises';
import type { Writable } from 'node:stream';

/**
 * Terminal prompting for the setup wizard.
 *
 * Two things it has to get right:
 *
 *  • **Secrets.** A wallet mnemonic is read with terminal echo off and outside
 *    readline entirely, so it never enters readline's line history.
 *  • **`--print`.** When the wizard's product is JSON on stdout, prompts have to
 *    go to stderr or they corrupt it — hence the configurable output stream.
 */
export class Prompter {
  private rl: Interface | null = null;

  constructor(
    private readonly output: Writable = process.stdout,
    /** `--yes`: never prompt, always take the default. */
    private readonly assumeYes = false
  ) {}

  /** True when prompting is possible at all (a TTY, and not `--yes`). */
  get interactive(): boolean {
    return !this.assumeYes && process.stdin.isTTY === true;
  }

  write(line = ''): void {
    this.output.write(`${line}\n`);
  }

  private get readline(): Interface {
    if (!this.rl) {
      this.rl = createInterface({ input: process.stdin, output: this.output });
    }
    return this.rl;
  }

  /** Close readline. Must be called before `secret()` and at the end of the wizard. */
  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  /** Free-text question with a default shown in brackets. */
  async ask(question: string, fallback: string): Promise<string> {
    if (!this.interactive) return fallback;
    const suffix = fallback === '' ? '' : ` [${fallback}]`;
    const answer = (await this.readline.question(`${question}${suffix}: `)).trim();
    return answer === '' ? fallback : answer;
  }

  /** Yes/no question. */
  async confirm(question: string, fallback: boolean): Promise<boolean> {
    if (!this.interactive) return fallback;
    const answer = (await this.ask(`${question} (y/n)`, fallback ? 'y' : 'n')).toLowerCase();
    return answer.startsWith('y');
  }

  /** Single choice from a fixed set, matched on unique prefix. */
  async choose<T extends string>(question: string, choices: readonly T[], fallback: T): Promise<T> {
    if (!this.interactive) return fallback;
    for (;;) {
      const answer = (await this.ask(`${question} (${choices.join('/')})`, fallback)).toLowerCase();
      const match = choices.filter((choice) => choice.toLowerCase().startsWith(answer));
      if (match.length === 1) return match[0];
      this.write(`  Please answer one of: ${choices.join(', ')}`);
    }
  }

  /** Number, re-asked until it parses and passes `validate`. */
  async askNumber(question: string, fallback: number, validate: (n: number) => string | null): Promise<number> {
    if (!this.interactive) return fallback;
    for (;;) {
      const raw = await this.ask(question, String(fallback));
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        this.write(`  "${raw}" is not a number.`);
        continue;
      }
      const problem = validate(value);
      if (problem) {
        this.write(`  ${problem}`);
        continue;
      }
      return value;
    }
  }

  /**
   * Read a line with echo off. Closes readline first so the input is never
   * captured in its history — the caller must not hold an open question.
   */
  async secret(question: string): Promise<string> {
    this.close();
    return readSecret(question, this.output);
  }
}

function readSecret(prompt: string, output: Writable): Promise<string> {
  const input = process.stdin;

  return new Promise<string>((resolve, reject) => {
    if (!input.isTTY) {
      reject(new Error('Cannot read a secret: stdin is not a terminal.'));
      return;
    }

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

/** Read all of stdin — used by `setup --mnemonic-stdin`. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}
