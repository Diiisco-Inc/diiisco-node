import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'smol-toml';
import { ModelWiringHook } from './types';

const PROFILE_NAME = 'diiisco-launch';

/**
 * Codex supports a separate named profile file
 * (`~/.codex/<profile>.config.toml`, loaded via `--profile <name>`) — this
 * adapter writes only to files it fully owns and always overwrites wholesale,
 * so `~/.codex/config.toml` itself is never touched. Verified against
 * Ollama's own `cmd/launch/codex.go`: its adapter follows the same pattern
 * and never merges into the user's main config in the steady-state path.
 *
 * `smol-toml`'s `stringify()` handles value escaping (base URLs, paths) —
 * used for safe serialization only; there is nothing to parse or merge since
 * the profile file is always fully regenerated.
 */
export const codexModelWiring: ModelWiringHook = async ({ model, endpoint }) => {
  const codexDir = join(homedir(), '.codex');
  mkdirSync(codexDir, { recursive: true });

  const catalogPath = join(codexDir, `${PROFILE_NAME}.model.json`);
  writeFileSync(catalogPath, JSON.stringify({ models: [buildCatalogEntry(model)] }, null, 2), 'utf8');

  const profilePath = join(codexDir, `${PROFILE_NAME}.config.toml`);
  writeFileSync(profilePath, buildProfileToml(model, catalogPath, endpoint), 'utf8');

  return { args: ['--profile', PROFILE_NAME, '-m', model] };
};

function buildProfileToml(model: string, catalogPath: string, endpoint: string): string {
  const baseURL = `${endpoint.replace(/\/$/, '')}/v1/`;

  // Root keys, then the provider table — `stringify` on the whole object
  // would be equally correct but reorders/nests unpredictably across smol-toml
  // versions; building it in two explicit calls keeps root keys before the
  // table, which is the layout Codex's own docs show.
  const root = stringify({
    model,
    model_provider: PROFILE_NAME,
    model_catalog_json: catalogPath,
  });
  const provider = stringify({
    model_providers: {
      [PROFILE_NAME]: {
        name: 'DIIISCO',
        base_url: baseURL,
        wire_api: 'responses',
      },
    },
  });
  return `${root}\n${provider}`;
}

/**
 * Minimal viable entry for Codex's `-c model_catalog_json=<path>` catalog.
 * Field names mirror Ollama's `buildCodexModelEntry` (`cmd/launch/codex.go`)
 * as the best available reference; verify against an installed `codex`
 * binary if it rejects this shape (see plan phase 3 notes).
 */
function buildCatalogEntry(model: string): Record<string, unknown> {
  return {
    slug: model,
    display_name: model,
    context_window: 128_000,
    shell_type: 'default',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    input_modalities: ['text'],
    base_instructions: '',
    support_verbosity: true,
    default_verbosity: 'low',
    supports_parallel_tool_calls: false,
    supports_reasoning_summaries: false,
    supported_reasoning_levels: [],
    experimental_supported_tools: [],
  };
}
