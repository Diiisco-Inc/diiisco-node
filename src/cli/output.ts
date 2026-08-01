/**
 * Terminal output helpers. Everything the CLI prints for humans goes through
 * here so colour can be switched off in one place (`NO_COLOR`, a non-TTY pipe,
 * or `--json`, which must emit machine-readable output and nothing else).
 */

let colourEnabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY);

let quiet = false;

/** Suppress all human-facing chatter (used by `--json` paths). */
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function isQuiet(): boolean {
  return quiet;
}

function paint(code: string, text: string): string {
  return colourEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const colour = {
  bold: (t: string) => paint('1', t),
  dim: (t: string) => paint('2', t),
  red: (t: string) => paint('31', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  cyan: (t: string) => paint('36', t),
};

export function setColour(enabled: boolean): void {
  colourEnabled = enabled;
}

/** Human-facing line on stdout. Silenced by `--json`. */
export function info(message = ''): void {
  if (!quiet) process.stdout.write(`${message}\n`);
}

/** Always printed on stdout, even in quiet mode (this *is* the output). */
export function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${colour.yellow('!')} ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`${colour.red('✗')} ${message}\n`);
}

export function success(message: string): void {
  if (!quiet) process.stdout.write(`${colour.green('✓')} ${message}\n`);
}

/**
 * Fail with an actionable message and no stack trace. Extra lines are printed
 * underneath, indented — used for "here is what to do next" hints.
 */
export function die(message: string, ...hints: string[]): never {
  error(message);
  for (const hint of hints) process.stderr.write(`  ${colour.dim(hint)}\n`);
  process.exit(1);
}

/** Pretty-print JSON for machine consumers (stable, 2-space indented). */
export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
