import { ModelWiringHook } from './types';

/**
 * `OPENCODE_CONFIG_CONTENT` is a documented OpenCode env var carrying inline
 * JSON config — lower in its config precedence than a project/custom file, so
 * it never clobbers anything the user has actually written, but high enough
 * to define a provider OpenCode otherwise has no way to know about. No file
 * writes needed.
 */
export const opencodeModelWiring: ModelWiringHook = async ({ model, endpoint, key }) => ({
  env: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        diiisco: {
          npm: '@ai-sdk/openai-compatible',
          name: 'DIIISCO',
          options: {
            baseURL: `${endpoint.replace(/\/$/, '')}/v1`,
            apiKey: key,
          },
          models: {
            [model]: { name: model },
          },
        },
      },
    }),
  },
});
