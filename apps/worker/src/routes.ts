/**
 * The /api router for the Worker. Deny-by-default RBAC (reusing the domain
 * `can()`), then dispatch to a D1-backed handler (auth → handler → D1). This set
 * covers the full PWA surface — the five screens a user clicks through
 * (Dispense, Patients, Queue, Calendar, Command centre) — on Cloudflare/D1.
 */
import { can, type Permission, StockError } from '@sancta/domain';
import {
  skuOnHand, commitCheckoutD1, DuplicateCheckoutError,
  listPatients, registerPatient, startVisit, queueBoard, createSlot, calendarView, dashboard,
  type D1Database, type CheckoutD1Request,
} from '@sancta/d1';
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
    // --- Patients: list / search / register -------------------------------
    if (p === '/api/patients' && method === 'GET') {
      const denied = guard('discover');
      if (denied) return denied;
      const q = url.searchParams.get('q') ?? undefined;
      return json({ patients: await listPatients(env.DB, q) });
    }
    if (p === '/api/patients' && method === 'POST') {
      const denied = guard('create');
      if (denied) return denied;
      const body = (await request.json()) as Record<string, unknown>;
      const result = await registerPatient(env.DB, { ...body, ...(auth.user ? { user: auth.user } : {}) });
      return json(result, result.ok ? 201 : 200);
    }

    // --- Stock + the flagship dispense-and-pay ----------------------------
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

    // --- Visits: queue board + check-in -----------------------------------
    if (p === '/api/visits/queue' && method === 'GET') {
      const denied = guard('view_summary');
      if (denied) return denied;
      const station = url.searchParams.get('station') ?? undefined;
      return json({ queue: await queueBoard(env.DB, station) });
    }
    if (p === '/api/visits/start' && method === 'POST') {
      const denied = guard('create');
      if (denied) return denied;
      const body = (await request.json()) as { patientId: string; station?: string };
      return json(await startVisit(env.DB, body), 201);
    }

    // --- Scheduling: calendar feed + create slot --------------------------
    if (p === '/api/schedule/calendar' && method === 'GET') {
      const denied = guard('view_summary');
      if (denied) return denied;
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? from;
      return json({ entries: await calendarView(env.DB, { from, to }) });
    }
    if (p === '/api/schedule/slot' && method === 'POST') {
      const denied = guard('create');
      if (denied) return denied;
      const body = (await request.json()) as { provider: string; startsAt: string; endsAt: string; room?: string; serviceCode?: string };
      return json(await createSlot(env.DB, body), 201);
    }

    // --- Command centre ----------------------------------------------------
    if (p === '/api/management/dashboard' && method === 'GET') {
      const denied = guard('view_summary');
      if (denied) return denied;
      return json(await dashboard(env.DB, new Date().toISOString()));
    }

    // --- Sync: cloud-native no-ops ----------------------------------------
    // In the all-Cloudflare deployment the PWA writes straight to D1, so there is
    // no edge→cloud outbox. These keep the PWA's background sync calls happy: the
    // queue is always empty and a "push" has nothing to send.
    if (p === '/api/sync/status' && method === 'GET') {
      const denied = guard('view_summary');
      if (denied) return denied;
      return json({ pending: 0 });
    }
    if (p === '/api/sync/push' && method === 'POST') {
      const denied = guard('view_summary');
      if (denied) return denied;
      return json({ attempted: 0, acknowledged: 0, failed: 0, deferred: 0 });
    }

    return json({ error: { code: 'not_found' } }, 404);
  } catch (e) {
    return json({ error: { code: 'internal', message: String((e as Error).message) } }, 500);
  }
}
