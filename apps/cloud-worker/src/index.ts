/**
 * Cloudflare Worker entry — cloud API, sync ingress and integration gateway
 * (CLD-001/002, ADR-0003). This is a Phase-1 skeleton: routes, cache-safety and
 * the sync-ingress contract are in place; PostgreSQL access lands via a
 * cache-disabled Hyperdrive binding (CLD-004/005) with app code.
 *
 * Boundary reminder (NFR-038): this plane is an ENHANCEMENT. The clinic edge hub
 * serves launch-core LAN workflows with or without this Worker being reachable.
 */
import { protectedJson, errorJson, isProtectedPath } from './http.ts';
import { handleSyncIngress } from './sync-ingress.ts';

type Env = {
  // Hyperdrive binding (cache-disabled on protected paths — CLD-005).
  readonly HYPERDRIVE?: unknown;
  // R2 buckets (documents/reports/backups — CLD-006), Queues (CLD-003), etc.
  readonly SCHEMA_VERSION?: string;
};

function correlationId(): string {
  // Support correlation only — never contains PHI (NFR-018/026).
  return 'cw-' + Math.random().toString(36).slice(2, 10);
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cid = correlationId();

    // Health is the one unauthenticated, cacheable-by-design endpoint.
    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ status: 'ok', plane: 'cloud' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    // Sync ingress (SYN protocol step 4-6). Idempotent, returns a durable receipt.
    if (url.pathname === '/sync/ingress' && request.method === 'POST') {
      try {
        const body = await request.json();
        const receipt = handleSyncIngress(body);
        return protectedJson(receipt, 200);
      } catch (_e) {
        return errorJson(400, 'sync_ingress_invalid', cid);
      }
    }

    // All other protected paths must be no-store; unimplemented in this skeleton.
    if (isProtectedPath(url.pathname)) {
      return errorJson(501, 'not_implemented', cid);
    }

    return errorJson(404, 'not_found', cid);
  },
};
