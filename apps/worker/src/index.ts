/**
 * The Sancta clinic app as a single Cloudflare Worker (D1 migration target):
 *  - /healthz            → liveness (no-store)
 *  - /api/*              → the API, on D1 (env.DB), deny-by-default RBAC
 *  - everything else     → the PWA served from Static Assets (env.ASSETS)
 *
 * Deployed from GitHub via `wrangler deploy`; the D1 schema is applied by
 * `wrangler d1 migrations apply` in the deploy pipeline (never from the Worker).
 */
import { handleApi, type Env } from './routes.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ status: 'ok', plane: 'cloud', db: 'd1' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    // Static assets (the PWA). `run_worker_first: ["/api/*"]` in wrangler.toml means
    // only /api/* reaches this Worker; other paths are served directly from assets,
    // but we forward here too so the Worker can serve them when invoked.
    return env.ASSETS.fetch(request);
  },
};
