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
  createOrder, setOrderStatus, releaseResult, acknowledgeCritical, outstandingCriticalResults,
  attachExternalResult, reconcileExternalResult, unmatchedResults, cancelOrder, correctResult,
  defineOrderSet, applyOrderSet, generateSpecimenLabel, createReferral, updateReferral, listOpenReferrals, OrderError,
  createDraftEncounter, updateDraft, signEncounter, addAddendum, markEnteredInError, getEncounter, EncounterError,
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

    // --- Clinical encounters (EHR-008/009, BR-003, UAT-04) ----------------
    if (p.startsWith('/api/encounters')) {
      try {
        if (p === '/api/encounters' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const b = (await request.json()) as { patientId: string };
          return json(await createDraftEncounter(env.DB, { ...b, ...(auth.user ? { user: auth.user } : {}) }), 201);
        }
        if (p === '/api/encounters/draft' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          await updateDraft(env.DB, (await request.json()) as Parameters<typeof updateDraft>[1]);
          return json({ ok: true });
        }
        if (p === '/api/encounters/sign' && method === 'POST') {
          const denied = guard('sign'); if (denied) return denied;
          return json(await signEncounter(env.DB, (await request.json()) as Parameters<typeof signEncounter>[1]));
        }
        if (p === '/api/encounters/addendum' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await addAddendum(env.DB, (await request.json()) as Parameters<typeof addAddendum>[1]), 201);
        }
        if (p === '/api/encounters/entered-in-error' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await markEnteredInError(env.DB, (await request.json()) as Parameters<typeof markEnteredInError>[1]));
        }
        if (p === '/api/encounters/get' && method === 'GET') {
          const denied = guard('view_clinical_detail'); if (denied) return denied;
          return json(await getEncounter(env.DB, url.searchParams.get('id') ?? ''));
        }
      } catch (e) {
        if (e instanceof EncounterError) return json({ error: { code: 'encounter_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Orders, results & critical-result acknowledgement (ORD, UAT-06) --
    if (p.startsWith('/api/orders') || p.startsWith('/api/referrals')) {
      try {
        if (p === '/api/orders' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await createOrder(env.DB, (await request.json()) as Parameters<typeof createOrder>[1]), 201);
        }
        if (p === '/api/orders/result' && method === 'POST') {
          const denied = guard('sign'); if (denied) return denied;
          return json(await releaseResult(env.DB, (await request.json()) as Parameters<typeof releaseResult>[1]), 201);
        }
        if (p === '/api/orders/critical/ack' && method === 'POST') {
          const denied = guard('sign'); if (denied) return denied;
          return json(await acknowledgeCritical(env.DB, (await request.json()) as Parameters<typeof acknowledgeCritical>[1]));
        }
        if (p === '/api/orders/critical/outstanding' && method === 'GET') {
          const denied = guard('view_clinical_detail'); if (denied) return denied;
          return json({ results: await outstandingCriticalResults(env.DB) });
        }
        if (p === '/api/orders/external-result' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await attachExternalResult(env.DB, (await request.json()) as Parameters<typeof attachExternalResult>[1]), 201);
        }
        if (p === '/api/orders/external-result/reconcile' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await reconcileExternalResult(env.DB, (await request.json()) as Parameters<typeof reconcileExternalResult>[1]));
        }
        if (p === '/api/orders/unmatched' && method === 'GET') {
          const denied = guard('view_clinical_detail'); if (denied) return denied;
          return json({ unmatched: await unmatchedResults(env.DB) });
        }
        if (p === '/api/orders/cancel' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await cancelOrder(env.DB, (await request.json()) as Parameters<typeof cancelOrder>[1]));
        }
        if (p === '/api/orders/result/correct' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await correctResult(env.DB, (await request.json()) as Parameters<typeof correctResult>[1]));
        }
        if (p === '/api/orders/status' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await setOrderStatus(env.DB, (await request.json()) as Parameters<typeof setOrderStatus>[1]));
        }
        if (p === '/api/orders/set' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await defineOrderSet(env.DB, (await request.json()) as Parameters<typeof defineOrderSet>[1]), 201);
        }
        if (p === '/api/orders/set/apply' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const b = (await request.json()) as { setCode: string; patientId: string; encounterId?: string };
          return json(await applyOrderSet(env.DB, { ...b, ...(auth.user ? { requestedBy: auth.user } : {}) }), 201);
        }
        if (p === '/api/orders/specimen-label' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await generateSpecimenLabel(env.DB, (await request.json()) as Parameters<typeof generateSpecimenLabel>[1]), 201);
        }
        if (p === '/api/referrals' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const b = (await request.json()) as Parameters<typeof createReferral>[1];
          return json(await createReferral(env.DB, { ...b, ...(auth.user ? { sentBy: auth.user } : {}) }), 201);
        }
        if (p === '/api/referrals/status' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await updateReferral(env.DB, (await request.json()) as Parameters<typeof updateReferral>[1]));
        }
        if (p === '/api/referrals/open' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json({ referrals: await listOpenReferrals(env.DB) });
        }
      } catch (e) {
        if (e instanceof OrderError) return json({ error: { code: 'order_rejected', message: e.message } }, 409);
        throw e;
      }
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
