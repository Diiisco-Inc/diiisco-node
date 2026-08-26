/**
 * Typed failures for a mesh inference request.
 *
 * The API layer used to await a promise whose only resolve path was the
 * `inference-response` event, so anything that went wrong on the provider side
 * — a stopped backend most of all — left the HTTP request hanging until the
 * client gave up. These give each failure a deadline and a status code.
 */

/** Nobody quoted for the model within the auction window. */
export class NoProviderError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`No node on the network is currently serving "${model}".`);
    this.name = 'NoProviderError';
    this.model = model;
  }
}

/** A quote was accepted but the answer never arrived within the deadline. */
export class InferenceTimeoutError extends Error {
  readonly model: string;
  constructor(model: string, timeoutMs: number) {
    super(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a response for "${model}".`);
    this.name = 'InferenceTimeoutError';
    this.model = model;
  }
}

/**
 * The selected provider reported that it could not run the inference — it sent
 * an `inference-failed` rather than leaving the requester to time out. Carries
 * the provider so the retry can exclude it from the next auction.
 */
export class ProviderFailedError extends Error {
  readonly model: string;
  readonly providerPeerId: string;
  readonly reason: string;
  constructor(model: string, providerPeerId: string, reason: string) {
    super(`Provider ${providerPeerId.slice(0, 16)}… could not serve "${model}" (${reason}).`);
    this.name = 'ProviderFailedError';
    this.model = model;
    this.providerPeerId = providerPeerId;
    this.reason = reason;
  }
}

/** HTTP status for a failure from this module; 500 for anything else. */
export function statusForInferenceError(err: unknown): number {
  if (err instanceof NoProviderError) return 503;
  if (err instanceof ProviderFailedError) return 503;
  if (err instanceof InferenceTimeoutError) return 504;
  return 500;
}

/** User-facing message for a failure from this module; a generic one otherwise. */
export function messageForInferenceError(err: unknown): string {
  if (err instanceof NoProviderError || err instanceof InferenceTimeoutError || err instanceof ProviderFailedError) {
    return err.message;
  }
  return 'No peers available to handle the request.';
}
