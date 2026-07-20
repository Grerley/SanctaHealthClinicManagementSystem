/**
 * Shared route extraction for the API contract tooling. The edge server declares
 * every route with the regular guard `p === '/api/...' && req.method === 'VERB'`
 * (plus the public `/healthz`), so the set of routes can be read directly from the
 * source — the single source of truth both the generator and the contract check
 * derive from.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requiredPermission } from '../../apps/clinic-edge/src/http-auth.ts';

export type Route = { method: string; path: string; permission: string | null };

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');

export function extractRoutes(): Route[] {
  const src = readFileSync(join(repoRoot, 'apps/clinic-edge/src/server.ts'), 'utf8');
  const re = /p === '(\/api\/[^']+)' && req\.method === '(GET|POST|PUT|DELETE|PATCH)'/g;
  const seen = new Set<string>();
  const routes: Route[] = [];
  for (const m of src.matchAll(re)) {
    const path = m[1] as string;
    const method = m[2] as string;
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path, permission: requiredPermission(method, path) });
  }
  // The public health probe is served outside the /api/ guard.
  routes.push({ method: 'GET', path: '/healthz', permission: null });
  routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return routes;
}

/** Module tag from the first path segment (e.g. /api/finance/... → finance). */
export function tagFor(path: string): string {
  if (path === '/healthz') return 'system';
  const seg = path.split('/')[2] ?? 'misc';
  return seg;
}
