import { colour, info, warn } from './output';
import { Prompter } from './prompt';

/** Clamp the client-side wait for `/v1/models` — see the note below. */
const MIN_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 20_000;
const REMOTE_TIMEOUT_MS = 8_000;

interface ModelListResponse {
  object?: string;
  data?: Array<{ id?: string }>;
}

/**
 * Resolve the model id `launch` should wire into a tool, in priority order:
 *
 *   1. `explicit` (the user's `--model`) — always wins, no network call.
 *   2. Exactly one model on the mesh — used directly, no prompt.
 *   3. Multiple models, interactive session — a numbered picker.
 *   4. Multiple models, non-interactive (`--yes` or no TTY) — the first one,
 *      deterministically (documented in `help.ts`).
 *   5. Zero models, a timeout, or a fetch error — `undefined`. Non-fatal: the
 *      caller falls back to not wiring a model at all, exactly like today.
 *
 * `waitHintMs` is the local node's own `quoteEngine.waitTime` when launching
 * a node we just started — irrelevant (and unavailable) for a `--endpoint`
 * pointed at somebody else's node, hence the floor/ceiling clamp below.
 */
export async function resolveLaunchModel(
  endpoint: string,
  key: string,
  explicit: string | undefined,
  waitHintMs: number,
  assumeYes: boolean
): Promise<string | undefined> {
  if (explicit) return explicit;

  const models = await fetchModelIds(endpoint, key, waitHintMs);
  if (models.length === 0) {
    warn("No mesh models found — falling back to the tool's own defaults.");
    return undefined;
  }

  if (models.length === 1) {
    info(colour.dim(`  model: ${models[0]}`));
    return models[0];
  }

  const prompter = new Prompter(process.stdout, assumeYes);
  if (!prompter.interactive) {
    info(colour.dim(`  model: ${models[0]} (${models.length} available — pass --model to pick another)`));
    return models[0];
  }

  info(colour.bold('Multiple models are available on the mesh:'));
  const selected = await prompter.pickFromList('Select a model', models, models[0]);
  prompter.close();
  return selected;
}

/**
 * `GET /v1/models` has no server-side timeout guard — if zero mesh peers
 * respond, the aggregation event that would answer the request never fires,
 * and the request hangs forever (see src/utils/models.ts, src/api/server.ts).
 * The client applies its own deadline so `launch` degrades instead of hanging.
 */
async function fetchModelIds(endpoint: string, key: string, waitHintMs: number): Promise<string[]> {
  const timeoutMs = waitHintMs > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(waitHintMs + 3_000, MIN_TIMEOUT_MS))
    : REMOTE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/models`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as ModelListResponse;
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
