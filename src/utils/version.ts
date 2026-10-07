import { readFileSync } from 'fs';

/**
 * The node's own version, shared by the CLI and the published node profile.
 *
 * A compiled single-file binary has no `package.json` to read at runtime, so
 * the value is baked in at build time with
 * `bun build --define process.env.DIIISCO_VERSION='"1.0.8"'`. A source checkout,
 * PM2 or a library consumer has no define but does have a `package.json` next to
 * the bundle; the constant below is the last resort.
 */

/** Kept in step with package.json's `version` field. */
export const FALLBACK_VERSION = '1.0.9';

let cachedPackageVersion: string | null | undefined;

/** Package version, resolved relative to the module (`dist/*.js` or `src/utils/`). */
function packageVersion(): string | null {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion;
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf-8'));
      if (pkg.name === 'diiisco-node' && typeof pkg.version === 'string') {
        const found: string = pkg.version;
        cachedPackageVersion = found;
        return found;
      }
    } catch {}
  }
  cachedPackageVersion = null;
  return null;
}

export function version(): string {
  return process.env.DIIISCO_VERSION || packageVersion() || FALLBACK_VERSION;
}
