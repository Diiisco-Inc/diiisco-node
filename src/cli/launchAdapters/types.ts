import type { LaunchTarget } from '../apps';

export interface ModelWiringContext {
  model: string;
  endpoint: string;
  key: string;
  target: LaunchTarget;
}

export interface ModelWiringResult {
  /** Extra env vars merged over the wire-transport env before spawning. */
  env?: Record<string, string>;
  /** Extra argv prepended before `target.args`/passthrough args. */
  args?: string[];
}

/**
 * Wires a resolved model id into one specific tool's own config surface
 * (env vars, a config file, a one-shot subprocess, ...) before it is spawned.
 * Only the built-in apps that have one registered in `./index.ts` get this —
 * user-defined `cli.apps` entries keep the generic `--model` behavior.
 */
export type ModelWiringHook = (ctx: ModelWiringContext) => Promise<ModelWiringResult>;
