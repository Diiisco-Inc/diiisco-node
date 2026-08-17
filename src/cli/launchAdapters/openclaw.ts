import { spawn } from 'node:child_process';
import { die } from '../output';
import { ModelWiringHook } from './types';

/**
 * OpenClaw has no env-var or inline-config surface for a custom backend — it
 * owns its config entirely through `openclaw onboard`, a one-shot wizard.
 * `--non-interactive --accept-risk` skips the interactive risk confirmation
 * and prompts; `--auth-choice custom-api-key` (not `ollama`) is the
 * tool-agnostic value documented to work with any OpenAI-compatible backend,
 * paired with `--custom-compatibility openai`. The key travels via the
 * `CUSTOM_API_KEY` env var, not argv, matching this codebase's existing
 * convention of keeping secrets out of process argv (`ps` visibility).
 *
 * Runs once, to completion, before the real interactive `openclaw` spawn —
 * DIIISCO writes no files of its own here, `openclaw onboard` writes
 * OpenClaw's own config.
 */
export const openclawModelWiring: ModelWiringHook = async ({ model, endpoint, key, target }) => {
  const onboardArgs = [
    'onboard',
    '--non-interactive',
    '--accept-risk',
    '--auth-choice', 'custom-api-key',
    '--custom-compatibility', 'openai',
    '--custom-provider-id', 'diiisco',
    '--custom-base-url', endpoint,
    '--custom-model-id', model,
  ];

  await runToCompletion(target.bin, onboardArgs, { ...process.env, CUSTOM_API_KEY: key });

  return {};
};

function runToCompletion(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });

    child.on('error', (err: NodeJS.ErrnoException) => {
      die(`Could not run \`${bin} onboard\`: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (signal || code !== 0) {
        die(`\`${bin} onboard\` did not complete successfully.`, 'Run it by hand to see the full output.');
      }
      resolve();
    });
  });
}
