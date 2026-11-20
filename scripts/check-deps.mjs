#!/usr/bin/env node
/**
 * Fail if `dependencies` and the code disagree.
 *
 *   node scripts/check-deps.mjs
 *
 * Two checks, both about the same drift:
 *
 *  1. **Unused** — a package listed under `dependencies` that nothing in
 *     `src/`, `scripts/` or `pm2.config.cjs` imports. It is shipped weight and
 *     attack surface for nothing (review 1.0.12 found eleven).
 *  2. **Undeclared** — a bare import in `src/` of a package that is not in
 *     `dependencies` or `devDependencies`. It works today only because something
 *     else happens to install it.
 *
 * Deliberately simple: it reads import specifiers with a regex rather than
 * resolving them, which is enough for a project that uses plain ES imports.
 * A package used only by a tool the scripts invoke by name (not by import)
 * belongs in `TOOL_ONLY`, with the reason.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Runtime dependencies used by name (a CLI or a loader), not by import. Say why. */
const TOOL_ONLY = new Map([
  // (none today — `pm2` is a devDependency, run by the `node:*` scripts)
]);

const SOURCES = ['src', 'scripts', 'test'];
const EXTRA_FILES = ['pm2.config.cjs'];
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (EXTENSIONS.test(name)) yield path;
  }
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/g;

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`; relative and builtin → null. */
function packageOf(specifier) {
  if (/[${}\s]/.test(specifier)) return null; // text inside a template string, not a module name
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('bun:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return builtinModules.includes(name) ? null : name;
}

const usedBy = new Map(); // package -> first file importing it, per area
for (const area of SOURCES) {
  let dir;
  try { dir = join(root, area); statSync(dir); } catch { continue; }
  for (const file of walk(dir)) addImports(file, area);
}
for (const file of EXTRA_FILES) {
  try { addImports(join(root, file), 'scripts'); } catch { /* absent */ }
}

function addImports(file, area) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(IMPORT)) {
    const name = packageOf(match[1]);
    if (!name) continue;
    if (!usedBy.has(name)) usedBy.set(name, {});
    usedBy.get(name)[area] ??= file.slice(root.length + 1);
  }
}

const dependencies = Object.keys(pkg.dependencies ?? {});
const declared = new Set([...dependencies, ...Object.keys(pkg.devDependencies ?? {})]);
const problems = [];

for (const name of dependencies) {
  if (TOOL_ONLY.has(name)) continue;
  const uses = usedBy.get(name);
  if (!uses) problems.push(`unused dependency: "${name}" is in dependencies but nothing imports it`);
}

for (const [name, uses] of usedBy) {
  if (declared.has(name)) continue;
  if (!uses.src && !uses.scripts) continue; // test-only imports of undeclared packages are tolerated below
  problems.push(`undeclared dependency: "${name}" is imported (${uses.src ?? uses.scripts}) but not in package.json`);
}

if (problems.length > 0) {
  console.error(`check-deps: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check-deps: ${dependencies.length} dependencies, all used; no undeclared imports.`);
