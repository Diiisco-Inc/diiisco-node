#!/usr/bin/env node
/**
 * Post-build fixups for the tsup output.
 *
 * `package.json` declares `bin.diiisco -> dist/cli.js`, so an npm/bun install
 * of this package links `dist/cli.js` onto PATH. tsup does not add a shebang
 * (the TypeScript source has none — a shebang in `src/cli.ts` would end up in
 * the compiled Bun binary's payload too), so it is prepended here and the file
 * is made executable.
 *
 * This has nothing to do with the standalone executables in `dist/bin/` — those
 * are produced by `scripts/build-binaries.mjs`.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'dist', 'cli.js');

const SHEBANG = '#!/usr/bin/env node\n';

let source;
try {
  source = readFileSync(cli, 'utf8');
} catch (err) {
  console.error(`postbuild: could not read ${cli}: ${err.message}`);
  process.exit(1);
}

if (!source.startsWith('#!')) {
  writeFileSync(cli, SHEBANG + source, 'utf8');
}

try {
  chmodSync(cli, 0o755);
} catch {
  // Windows / exotic filesystems: the bin shim does not need the mode bit.
}

/*
 * The contributor workflow: `dist/dev.js` looks for a local override at
 * `./environment/environment` (relative to itself), which is the built form of
 * the gitignored `src/environment/environment.ts`. tsup bundles from
 * `src/dev.ts`, and that import is deliberately non-literal so the bundler can
 * never resolve it — so nothing else emits the file and `npm run serve` would
 * silently fall back to the committed defaults.
 *
 * Emit it here when the source exists. It is built into `dist/`, which is
 * gitignored, and it is never an input to the standalone binaries: those are
 * compiled from `src/cli.ts`, which reads `~/.diiisco/diiisco.config.json` and
 * has no path to this module at all.
 */
const localEnvironment = join(root, 'src', 'environment', 'environment.ts');
if (existsSync(localEnvironment)) {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [localEnvironment],
    outfile: join(root, 'dist', 'environment', 'environment.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2020',
    logLevel: 'warning',
  });
  console.log('postbuild: emitted dist/environment/environment.js (local override)');
}
