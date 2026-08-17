import { ModelWiringHook } from './types';

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
  },
});
