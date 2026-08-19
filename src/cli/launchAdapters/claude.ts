import { ModelWiringHook } from './types';

/**
 * DIIISCO has no source of truth for a served model's real context length
 * (mesh model listings are plain OpenAI `Model` objects — id/object/created/
 * owned_by, nothing richer). This is a deliberately conservative stand-in:
 * comfortably under Claude Code's own default assumption (sized for
 * Anthropic's ~200k-token models) so a DIIISCO-routed session compacts on its
 * own well before hitting the 32MB request cap, instead of hard-failing.
 */
const DEFAULT_AUTO_COMPACT_WINDOW = 128_000;

/**
 * Claude Code resolves its `opus`/`sonnet`/`haiku` tiers (and the subagent
 * model) through these officially documented env vars. Unrecognized model
 * strings pass through unchecked once `ANTHROPIC_BASE_URL` points somewhere
 * other than api.anthropic.com, so remapping all tiers to one DIIISCO model
 * id is enough to make Claude Code actually use it — no gateway-discovery
 * opt-in needed, and none would help anyway (it filters to ids containing
 * "claude"/"anthropic", which DIIISCO's marketplace model ids won't).
 */
export const claudeModelWiring: ModelWiringHook = async ({ model }) => ({
  env: {
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(DEFAULT_AUTO_COMPACT_WINDOW),
  },
});
