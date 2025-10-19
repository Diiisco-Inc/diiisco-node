import environment from "../environment/environment";

/** Parse "Authorization: Bearer <token>" */
function parseBearer(req: any) {
  const h = req.headers.authorization || "";
  const [scheme, token] = h.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

/** In-memory allowlist (use DB/Redis in prod if you need dynamic control) */
const allowed = new Set(environment.api.keys.map((s: string) => s.trim()).filter(Boolean));

/** Bearer auth middleware */
export function requireBearer(req: any, res: any, next: any) {
  const token = parseBearer(req);
  if (!token) return res.status(401).json({ error: "missing_bearer_token" });

  if (!allowed.has(token)) return res.status(403).json({ error: "invalid_token", allowed: JSON.stringify([...allowed]) });

  // attach auth info for downstream handlers
  req.auth = { token, type: "opaque" };
  return next();
}