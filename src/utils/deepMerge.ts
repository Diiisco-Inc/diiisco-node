/**
 * Deep merge utility for partial config overrides.
 * Recursively merges source into target, preserving nested objects.
 */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target } as T;
  for (const key in source) {
    const sourceVal = source[key];
    if (sourceVal !== undefined) {
      if (
        typeof sourceVal === 'object' &&
        sourceVal !== null &&
        !Array.isArray(sourceVal) &&
        typeof (target as any)[key] === 'object'
      ) {
        (result as any)[key] = deepMerge((target as any)[key], sourceVal as any);
      } else {
        (result as any)[key] = sourceVal;
      }
    }
  }
  return result;
}
