import { logger } from './logger';

/**
 * Keep the node alive through an aborted socket teardown, and give every other
 * fatal error a log line before the process goes.
 *
 * Under Bun, an aborted or timed-out TCP dial can destroy a `net.Socket` with a
 * `DOMException` after libp2p has removed the socket's `'error'` listener. The
 * event lands on an emitter with no listener and — because a `DOMException` is
 * not a JSC `Error` — `node:events` raises `ERR_UNHANDLED_ERROR` instead of
 * rethrowing the abort, with the original stashed on `.context`. Nothing in the
 * call stack can catch it: the throw happens on a later tick, inside
 * `internal:streams/destroy`, so the `try`/`catch` around the dial has long
 * since returned. Without a process-level handler the node exits and drops off
 * the mesh. `src/libp2p/bunSafeTcp.ts` removes the known trigger; this is the
 * backstop for the same failure arriving by another route.
 *
 * Only that signature is swallowed. Anything else keeps today's behaviour — log
 * it and exit non-zero — because a handler that swallows every uncaught error
 * leaves the node running on state nobody has reasoned about, which is worse
 * than a restart.
 */

/** Installed once per process; `dev.ts` and `runServe()` both call this, and the desktop app may too. */
let installed = false;

/** Aborted teardowns are expected and frequent; log the first in full and count the rest. */
let abortedTeardowns = 0;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err: unknown) => {
    if (handleAbortedTeardown(err)) return;
    logger.error('🚨 Uncaught exception — exiting:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    if (handleAbortedTeardown(reason)) return;
    logger.error('🚨 Unhandled promise rejection — exiting:', reason);
    process.exit(1);
  });
}

/** True when `err` was an aborted socket teardown and has been dealt with. */
function handleAbortedTeardown(err: unknown): boolean {
  const name = abortedTeardownName(err);
  if (name === null) return false;

  abortedTeardowns += 1;
  if (abortedTeardowns === 1) {
    logger.warn(
      `⚠️ Ignored an aborted socket teardown (${name}) — a dial was cancelled after its error listener was removed. ` +
        'Harmless; further occurrences are logged at debug level.'
    );
  } else {
    logger.debug(`Ignored an aborted socket teardown (${name}) — ${abortedTeardowns} so far`);
  }
  return true;
}

/**
 * The `name` of an abort/timeout teardown, or null if this is a real error.
 *
 * Kept deliberately narrow: the payload has to be *named* as an abort or a
 * timeout **and** carry a matching code. `DOMException` uses the numeric legacy
 * codes (`ABORT_ERR` 20, `TIMEOUT_ERR` 23); Node's own `AbortError` uses the
 * string `ABORT_ERR`.
 */
function abortedTeardownName(err: unknown): string | null {
  if (err == null || typeof err !== 'object') return null;

  // Bun wraps an unhandled 'error' event whose payload is not an Error, putting
  // the original on `.context`. Anywhere else the error arrives as itself.
  const wrapper = err as { code?: unknown; context?: unknown };
  const payload = wrapper.code === 'ERR_UNHANDLED_ERROR' ? wrapper.context : err;
  if (payload == null || typeof payload !== 'object') return null;

  const { name, code } = payload as { name?: unknown; code?: unknown };
  if (name !== 'AbortError' && name !== 'TimeoutError') return null;
  if (code !== 20 && code !== 23 && code !== 'ABORT_ERR' && code !== 'ERR_ABORTED') return null;

  return name;
}

/** Test seam: the number of teardowns swallowed so far. */
export function abortedTeardownCount(): number {
  return abortedTeardowns;
}
