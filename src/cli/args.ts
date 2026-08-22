/**
 * Minimal argv parsing.
 *
 * Deliberately hand-rolled rather than `node:util`'s `parseArgs`: `launch` has
 * to stop parsing at the first positional so that everything after the app name
 * is forwarded verbatim to the child process (`diiisco launch claude --resume`
 * must give `--resume` to Claude Code, not to the CLI).
 */

export interface ParsedArgs {
  /** Positional arguments, in order. */
  positionals: string[];
  /** Flag values. A boolean flag is `true`; `--key K` yields the string. */
  flags: Map<string, string | boolean>;
  /** Arguments after the parser stopped (`--`, or the passthrough positional). */
  rest: string[];
}

export interface ParseOptions {
  /** Flags that consume the following argument as their value. */
  valueFlags?: string[];
  /** Stop parsing after this many positionals; the remainder becomes `rest`. */
  stopAfterPositionals?: number;
}

export function parseArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const rest: string[] = [];

  let i = 0;
  let stopped = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (stopped) {
      rest.push(arg);
      i += 1;
      continue;
    }

    if (arg === '--') {
      stopped = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (valueFlags.has(body)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`Flag --${body} needs a value.`);
        }
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      i += 1;
      continue;
    }

    // Short flags: -f, -n 20, -n20
    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.slice(1);
      const name = body[0];
      if (valueFlags.has(name)) {
        if (body.length > 1) {
          flags.set(name, body.slice(1));
        } else {
          const next = argv[i + 1];
          if (next === undefined) throw new Error(`Flag -${name} needs a value.`);
          flags.set(name, next);
          i += 1;
        }
      } else {
        for (const ch of body) flags.set(ch, true);
      }
      i += 1;
      continue;
    }

    positionals.push(arg);
    i += 1;

    if (options.stopAfterPositionals !== undefined && positionals.length >= options.stopAfterPositionals) {
      stopped = true;
    }
  }

  return { positionals, flags, rest };
}

/** Read a flag as a string, trying each alias in order. */
export function flagString(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === 'string') return value;
    if (value === true) throw new Error(`Flag --${name} needs a value.`);
  }
  return undefined;
}

/** Read a flag as a boolean, trying each alias in order. */
export function flagBoolean(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => parsed.flags.has(name));
}

/** Read a flag as an integer, trying each alias in order. */
export function flagNumber(parsed: ParsedArgs, ...names: string[]): number | undefined {
  const raw = flagString(parsed, ...names);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Flag --${names[0]} expects a number (got "${raw}").`);
  return value;
}
