import { createHash, timingSafeEqual } from "node:crypto";
import environment from "../environment/runtime";

/**
 * Extract the API key from a request. Supports the Anthropic-style
 * `x-api-key` header (so the stock Anthropic SDK works as a drop-in) and the
 * existing `Authorization: Bearer <token>` scheme.
 */
function parseApiKey(req: any) {
  const apiKeyHeader = req.headers["x-api-key"];
  if (apiKeyHeader) {
    return Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  }
  const h = req.headers.authorization || "";
  const [scheme, token] = h.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

/**
 * The accepted keys, as SHA-256 digests. Read per request rather than once at
 * module load: when the node is embedded (e.g. the desktop app), `api.keys` is
 * populated via `configureEnvironment` AFTER this module is imported, so an
 * allowlist frozen at import time would be empty and reject every key.
 */
function allowedDigests(): Buffer[] {
  return environment.api.keys
    .map((s: string) => s.trim())
    .filter(Boolean)
    .map(digest);
}

const digest = (key: string): Buffer => createHash("sha256").update(key).digest();

/**
 * Constant-time key check. Digests have a fixed length, so neither a key's
 * length nor how much of it matches is observable, and every allowed key is
 * compared so the position of a match is not either.
 */
function isAllowedKey(token: string): boolean {
  const presented = digest(token);
  let ok = false;
  for (const allowed of allowedDigests()) {
    if (timingSafeEqual(presented, allowed)) ok = true;
  }
  return ok;
}

/** Bearer auth middleware */
export function requireBearer(req: any, res: any, next: any) {
  const token = parseApiKey(req);
  if (!token) return res.status(401).json({
    "error": {
      "message": "You must provide an API key.",
      "type": "authentication_error",
      "param": null,
      "code": null
    }
  });

  if (!isAllowedKey(token)) return res.status(401).json({
    "error": {
      "message": "Incorrect API key provided.",
      "type": "authentication_error",
      "param": null,
      "code": null
    }
  });

  // attach auth info for downstream handlers
  req.auth = { token, type: "opaque" };
  return next();
}