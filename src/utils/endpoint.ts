import environment from "../environment/environment";

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
 * Build the allowlist from the current environment. Computed per request rather
 * than once at module load: when the node is embedded (e.g. the desktop app),
 * `api.keys` is populated via `configureEnvironment` AFTER this module is
 * imported, so an allowlist frozen at import time would be empty and reject
 * every key. Reading it per request keeps it in sync with the live config.
 */
function allowedKeys(): Set<string> {
  return new Set(environment.api.keys.map((s: string) => s.trim()).filter(Boolean));
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

  if (!allowedKeys().has(token)) return res.status(401).json({
    "error": {
      "message": "Incorrect API key provided: " + token,
      "type": "authentication_error",
      "param": null,
      "code": null
    }
  });

  // attach auth info for downstream handlers
  req.auth = { token, type: "opaque" };
  return next();
}