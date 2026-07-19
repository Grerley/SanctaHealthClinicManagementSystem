/**
 * HTTP response helpers enforcing the Cloudflare cache-safety rule (CLD-011,
 * NFR-035): every protected dynamic response carries `Cache-Control: no-store`
 * so neither the CDN nor Hyperdrive serves stale patient / clinical / finance
 * data, and PHI never lands in platform caches.
 */

export const PROTECTED_NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'pragma': 'no-cache',
  'x-content-type-options': 'nosniff',
};

/** JSON response for a protected path — always no-store. */
export function protectedJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...PROTECTED_NO_STORE_HEADERS } });
}

/**
 * Structured error that never leaks patient existence or infrastructure detail
 * (pack §16.1). Carries a correlation id for support (NFR-026).
 */
export function errorJson(status: number, code: string, correlationId: string): Response {
  return protectedJson({ error: { code, correlationId } }, status);
}

/** Paths whose responses must be no-store (auth, patient, clinical, finance, stock, admin). */
export function isProtectedPath(pathname: string): boolean {
  return /^\/(auth|patients|clinical|encounters|billing|invoices|payments|stock|inventory|finance|admin|sync)\b/.test(
    pathname,
  );
}
