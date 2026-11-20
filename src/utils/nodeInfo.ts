/**
 * Shape checks for what a node says about itself: its tags, and (see
 * `parsePerformance`) its per-model performance figures. These arrive in quotes
 * and in profiles from strangers, so every parser here is pure, never throws,
 * and copies through only the fields it checked. They prove shape and bounds,
 * not truth: the figures are the sender's own claims.
 */

/** Lowercase letters, digits and hyphens, starting with a letter or digit, at most 48 characters. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_TAGS = 16;

/**
 * A clean copy of a tag list, or `undefined` if `value` is not one: not an
 * array, more than `MAX_TAGS`, a tag that does not match `TAG_PATTERN`, or a
 * duplicate.
 */
export function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TAGS) return undefined;
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag) || seen.has(tag)) return undefined;
    seen.add(tag);
  }
  return [...seen];
}

/** Why a configured tag list is invalid, phrased for `validateEnvironment`, or `null` if it is fine. */
export function tagsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return '`node.tags` must be a list of strings, e.g. ["cuda", "nvidia-dgx-spark"].';
  if (value.length > MAX_TAGS) return `\`node.tags\` may hold at most ${MAX_TAGS} tags (got ${value.length}).`;
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
      return `\`node.tags\` entry ${JSON.stringify(tag)} is not a valid tag: use lowercase letters, digits and hyphens, starting with a letter or digit, at most 48 characters (e.g. "apple-silicon-m4-pro").`;
    }
    if (seen.has(tag)) return `\`node.tags\` lists "${tag}" more than once.`;
    seen.add(tag);
  }
  return null;
}
