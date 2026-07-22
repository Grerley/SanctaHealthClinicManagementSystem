/**
 * The /api router for the Worker. Deny-by-default RBAC (reusing the domain
 * `can()`), then dispatch to a D1-backed handler. This is the SKELETON set — the
 * proven read + the flagship write — wired end-to-end on the Worker against D1.
 * The remaining ~248 handlers are ported into this table in later passes; the
 * shape (auth → handler → D1) is fixed here.
 */
import { can, type Permission, StockError } from '@sancta/domain';
import { many, skuOnHand, commitCheckoutD1, DuplicateCheckoutError, type D1Database, type CheckoutD1Request } from '@sancta/d1';
import { authFromRequest } from './auth.ts';

export type Env = {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function forbidden(permission: Permission): Response {
  return json({ error: { code: 'forbidden', message: `permission required: ${permission}` } }, 403);
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = authFromRequest(request);
  const method = request.method;
  const p = url.pathname;
  const guard = (permission: Permission): Response | null => (can(auth.roles, permission) ? null : forbidden(permission));

  try {
    if (p === '/api/patients' && method === 'GET') {
      const denied = guard('discover');
      if (denied) return denied;
      const patients = await many(env.DB, `SELECT id, mrn, given_name, family_name, date_of_birth AS dob, sex FROM identity_patient WHERE deceased = 0 ORDER BY family_name, given_name LIMIT 200`);
      return json({ patients });
    }

    if (p === '/api/stock' && method === 'GET') {
      const denied = guard('view_summary');
      if (denied) return denied;
      const sku = url.searchParams.get('sku') ?? '';
      const location = url.searchParams.get('location') ?? 'MAIN';
      return json({ sku, onHand: await skuOnHand(env.DB, sku, location) });
    }

    if (p === '/api/checkout' && method === 'POST') {
      const denied = guard('create');
      if (denied) return denied;
      const body = (await request.json()) as CheckoutD1Request;
      try {
        return json(await commitCheckoutD1(env.DB, { ...body, ...(auth.user ? { dispense: { ...body.dispense, user: auth.user } } : {}) }), 201);
      } catch (e) {
        if (e instanceof DuplicateCheckoutError) return json({ ok: false, duplicate: true }, 409);
        if (e instanceof StockError) return json({ ok: false, error: { code: 'insufficient_stock', message: e.message } }, 409);
        throw e;
      }
    }

    return json({ error: { code: 'not_found' } }, 404);
  } catch (e) {
    return json({ error: { code: 'internal', message: String((e as Error).message) } }, 500);
  }
}
