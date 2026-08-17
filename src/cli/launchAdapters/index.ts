import { claudeModelWiring } from './claude';
import { codexModelWiring } from './codex';
import { hermesModelWiring } from './hermes';
import { opencodeModelWiring } from './opencode';
import { openclawModelWiring } from './openclaw';
import { ModelWiringHook } from './types';

/**
 * Per-tool "wire the resolved model into this tool's own config" hooks,
 * keyed by canonical app name (`src/cli/apps.ts`'s `BUILT_IN_APPS` keys) —
 * independent of whatever `bin` a user or test has substituted via a
 * `cli.apps` config override, so overriding `bin` for testing still exercises
 * the real hook. Apps with no entry here keep the generic `--model` behavior
 * (`ANTHROPIC_MODEL`/`OPENAI_MODEL`) unchanged.
 */
export const MODEL_WIRING: { [app: string]: ModelWiringHook | undefined } = {
  claude: claudeModelWiring,
  codex: codexModelWiring,
  hermes: hermesModelWiring,
  opencode: opencodeModelWiring,
  openclaw: openclawModelWiring,
};

export type { ModelWiringContext, ModelWiringResult, ModelWiringHook } from './types';
