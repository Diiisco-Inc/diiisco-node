/**
 * Host-name helpers for the HTTP API's bind address and its Host-header check.
 */

/** Addresses that mean "every interface" when bound. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/** True for an address only this machine can reach: `127.0.0.0/8`, `::1`, `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** True when binding `host` listens on every interface. */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim().toLowerCase());
}

/**
 * The host-name part of a `Host` header (`localhost:8080` → `localhost`,
 * `[::1]:8080` → `[::1]`), lower-cased, or `undefined` when it is absent or
 * does not parse as one.
 */
export function hostnameOfHostHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The host-name of a configured URL or bare host (`https://node.example.com:4242` → `node.example.com`). */
export function hostnameOfUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return hostnameOfHostHeader(value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0]);
}
