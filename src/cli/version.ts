/**
 * Version and provenance.
 *
 * A compiled single-file binary has no `package.json` to read at runtime, so
 * the values are baked in at build time. The build injects them with
 * `bun build --define process.env.DIIISCO_VERSION='"1.0.8"'` (and likewise
 * `DIIISCO_COMMIT` / `DIIISCO_INSTALL_SOURCE`); the fallbacks keep
 * `bun run src/cli.ts` working in a plain checkout.
 *
 * `version()` itself lives in `src/utils/version.ts` so the node profile can use
 * it without importing the CLI layer.
 */
import { version } from '../utils/version';

export { version };

export type InstallSource = 'standalone' | 'desktop-bundled' | 'source';

export function commit(): string | null {
  return process.env.DIIISCO_COMMIT || null;
}

/**
 * Where this binary came from — the update hint differs (§9.4): a
 * desktop-bundled CLI is updated by the desktop app, not by `install.sh`.
 */
export function installSource(): InstallSource {
  const source = process.env.DIIISCO_INSTALL_SOURCE;
  if (source === 'desktop-bundled' || source === 'standalone' || source === 'source') return source;
  return isCompiled() ? 'standalone' : 'source';
}

/**
 * True when running inside a `bun build --compile` executable rather than from
 * a source checkout. Bun serves the entry script from a virtual filesystem
 * (`/$bunfs/...`, `B:\~BUN\...`), so the script path does not exist on disk.
 */
export function isCompiled(): boolean {
  const script = process.argv[1];
  if (!script) return true;
  if (script.startsWith('/$bunfs/') || script.includes('~BUN')) return true;
  return script === process.execPath;
}

export function versionLine(): string {
  const parts = [`diiisco ${version()}`];
  const sha = commit();
  if (sha) parts.push(`(${sha.slice(0, 12)})`);
  parts.push(`[${installSource()}]`);
  return parts.join(' ');
}
