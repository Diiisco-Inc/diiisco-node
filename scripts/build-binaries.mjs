#!/usr/bin/env bun
/**
 * Build the standalone `diiisco` executables (spec §6.1).
 *
 *   bun scripts/build-binaries.mjs               # every target
 *   bun scripts/build-binaries.mjs --host        # just this machine's target
 *   bun scripts/build-binaries.mjs --target=bun-linux-x64,bun-windows-x64
 *
 * Output lands in `dist/bin/diiisco-<os>-<arch>[.exe]` plus a `SHA256SUMS`.
 * **That path is a contract**: the desktop repo's bundling step copies
 * `dist/bin/diiisco-<os>-<arch>[.exe]` into the app bundle, so renaming the
 * artifacts breaks the desktop build.
 *
 * `bun build --compile --target` cross-compiles, so one runner produces every
 * artifact; only signing and notarization (§6.2) need a matching host.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src', 'cli.ts');

/** target → artifact name. Both halves are part of the desktop contract. */
const TARGETS = [
  { target: 'bun-darwin-arm64', artifact: 'diiisco-darwin-arm64' },
  { target: 'bun-darwin-x64', artifact: 'diiisco-darwin-x64' },
  { target: 'bun-linux-x64', artifact: 'diiisco-linux-x64' },
  { target: 'bun-linux-arm64', artifact: 'diiisco-linux-arm64' },
  { target: 'bun-windows-x64', artifact: 'diiisco-windows-x64.exe' },
];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const outDir = join(root, value('out-dir') ?? join('dist', 'bin'));

function hostTarget() {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (!os || !arch) return null;
  return TARGETS.find((t) => t.target === `bun-${os}-${arch}`) ?? null;
}

let selected = TARGETS;
if (flag('host')) {
  const host = hostTarget();
  if (!host) fail(`No compile target for this host (${process.platform}/${process.arch}).`);
  selected = [host];
} else if (value('target')) {
  const wanted = value('target').split(',').map((s) => s.trim()).filter(Boolean);
  selected = wanted.map((name) => {
    const hit = TARGETS.find((t) => t.target === name || t.artifact === name || t.target === `bun-${name}`);
    if (!hit) fail(`Unknown target "${name}". Known: ${TARGETS.map((t) => t.target).join(', ')}`);
    return hit;
  });
}

// ---------------------------------------------------------------------------
// Build-time constants (src/cli/version.ts reads exactly these three names)
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = process.env.DIIISCO_VERSION?.replace(/^v/, '') || pkg.version;
const commit = process.env.DIIISCO_COMMIT || gitCommit() || '';
// `standalone` (install.sh / a direct download) or `desktop-bundled` (§9.4),
// which points the update hint at the desktop updater instead of install.sh.
const installSource = process.env.DIIISCO_INSTALL_SOURCE || 'standalone';

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Status pages (§6.1 "embedded assets")
// ---------------------------------------------------------------------------
//
// Not embedded, deliberately. Bun's standalone filesystem exposes embedded
// *files* at a controllable path but has no directories: `existsSync` on a
// bunfs directory is false and `readdirSync` throws ENOENT. `src/api/
// statusPages.ts` mounts `express.static(<dir>)` and only falls back when the
// directory is missing, so a half-embedded build would serve an index.html
// whose hashed JS/CSS 404 — strictly worse than the fallback page the source
// already renders (a one-paragraph shell pointing at /node.json and
// /nodes.json). Every JSON route works either way.
//
// Embedding properly needs a small change in statusPages.ts: import the built
// assets as a manifest and serve them from memory instead of stat-ing a
// directory. Until then this reports the situation rather than pretending.
function reportWebAssets() {
  const built = join(root, 'dist', 'web', 'index.html');
  if (existsSync(built)) {
    console.log('  status pages: dist/web exists but is NOT embedded (Bun bunfs has no directories);');
    console.log('                the binary serves the JSON routes and the built-in fallback shell.');
  } else {
    console.log('  status pages: no dist/web build found; the binary serves the built-in fallback shell.');
  }
}

// ---------------------------------------------------------------------------
// Secret guard
// ---------------------------------------------------------------------------
//
// `src/environment/environment.ts` is gitignored and holds a live mnemonic. The
// compile entry is `src/cli.ts`, which never imports it (the CLI's config comes
// from ~/.diiisco/diiisco.config.json), so it cannot be reached — but a future
// import would embed a spending key in a public release artifact, so verify
// rather than assume. Nothing from that file is ever printed.
// Three plain patterns rather than one with a `(?!\1)` backreference: that
// form matches under Node's regex engine and silently matches *nothing* under
// JavaScriptCore, which would have turned this guard into a no-op in exactly
// the runtime that builds the releases.
const STRING_LITERALS = [
  /'((?:\\.|[^'\\\r\n]){24,})'/g,
  /"((?:\\.|[^"\\\r\n]){24,})"/g,
  /`((?:\\.|[^`\\]){24,})`/g,
];

function literalsIn(source) {
  const found = new Set();
  for (const pattern of STRING_LITERALS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

/** Every committed file under src/, concatenated — the "this is not a secret" corpus. */
function committedSources() {
  const listed = spawnSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) return '';
  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .map((relative) => {
      try {
        return readFileSync(join(root, relative), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

function localSecretLiterals() {
  const path = join(root, 'src', 'environment', 'environment.ts');
  if (!existsSync(path)) return [];
  // A literal that also appears in a committed source file (an algod URL, a
  // default topic) is shared configuration, not a secret — checking for it
  // would fail every build.
  const public_ = committedSources();
  return [...literalsIn(readFileSync(path, 'utf8'))].filter((literal) => !public_.includes(literal));
}

const SECRETS = localSecretLiterals();

/**
 * A string every build contains, used to prove the scan itself works.
 *
 * Pick one with no backticks or `${}`: Bun re-emits template literals as
 * template literals, so their backticks are backslash-escaped in the embedded
 * payload and a naive byte search for them finds nothing. A plain quoted
 * string — which is what a leaked credential would be — is stored verbatim.
 */
const GUARD_CONTROL = 'No DIIISCO configuration found.';

function assertNoSecrets(file) {
  if (SECRETS.length === 0) return;
  const bytes = readFileSync(file);
  // Positive control: if the scan cannot find a string that is definitely in
  // the artifact, it cannot be trusted to find one that should not be.
  if (!bytes.includes(GUARD_CONTROL)) {
    fail(`the secret guard could not find its control string in ${file}; refusing to certify the artifact`);
  }
  for (const literal of SECRETS) {
    if (bytes.includes(literal)) {
      rmSync(file, { force: true });
      fail(
        `${file} embeds a string literal from the gitignored src/environment/environment.ts. ` +
        'The artifact has been deleted. Do not publish it.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function bunExecutable() {
  // Running under Bun already? Use the same binary, so the compiled runtime
  // matches the one that produced it.
  if (typeof globalThis.Bun !== 'undefined') return process.execPath;
  return 'bun';
}

function compile({ target, artifact }) {
  const outfile = join(outDir, artifact);
  const argv = [
    'build',
    '--compile',
    `--target=${target}`,
    entry,
    '--outfile',
    outfile,
    // msgpackr-extract is an optional native accelerator with a pure-JS
    // fallback; leaving it out keeps every artifact free of native code.
    // msgpackr guards the require in a try/catch, and the define below removes
    // even that branch.
    '--external',
    'msgpackr-extract',
    '--define',
    `process.env.DIIISCO_VERSION=${JSON.stringify(version)}`,
    '--define',
    `process.env.DIIISCO_COMMIT=${JSON.stringify(commit)}`,
    '--define',
    `process.env.DIIISCO_INSTALL_SOURCE=${JSON.stringify(installSource)}`,
    '--define',
    'process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED="true"',
  ];

  const started = Date.now();
  const result = spawnSync(bunExecutable(), argv, { cwd: root, stdio: 'inherit' });
  if (result.error) fail(`Could not run bun: ${result.error.message}`);
  if (result.status !== 0) fail(`bun build --compile --target=${target} exited ${result.status}`);
  if (!existsSync(outfile)) fail(`bun build --compile --target=${target} produced no ${outfile}`);

  assertNoSecrets(outfile);

  const size = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${artifact}  ${size} MB  ${Date.now() - started}ms`);
  return outfile;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * `SHA256SUMS` covers every artifact currently in the output directory, not
 * just the ones this run built — CI splits the matrix across runners and
 * assembles the checksum file once, and `install.sh` looks the artifact up by
 * name in a single file.
 */
function writeChecksums() {
  const files = readdirSync(outDir)
    .filter((name) => name.startsWith('diiisco-'))
    .sort();
  if (files.length === 0) return null;
  const body = files.map((name) => `${sha256(join(outDir, name))}  ${name}\n`).join('');
  const path = join(outDir, 'SHA256SUMS');
  writeFileSync(path, body, 'utf8');
  return { path, files };
}

function fail(message) {
  console.error(`build-binaries: ${message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

console.log(`diiisco ${version}${commit ? ` (${commit.slice(0, 12)})` : ''} [${installSource}]`);
console.log(`  entry:  ${entry}`);
console.log(`  output: ${outDir}`);
reportWebAssets();
console.log(
  SECRETS.length > 0
    ? `  secret guard: ${SECRETS.length} literal(s) from the gitignored src/environment/environment.ts`
    : '  secret guard: no local src/environment/environment.ts on this machine'
);
console.log('');

for (const target of selected) compile(target);

if (!flag('no-sums')) {
  const sums = writeChecksums();
  if (sums) console.log(`\n  ✓ SHA256SUMS (${sums.files.length} artifact${sums.files.length === 1 ? '' : 's'})`);
}
