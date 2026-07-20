/**
 * Clinic edge hub HTTP server. Runs on the clinic LAN mini-PC and is the
 * operational system of record for launch-core work (ADR-0001). It serves the
 * PWA and the local API, commits to local PostgreSQL, and pushes queued changes
 * to the cloud when reachable — but never depends on the cloud (NFR-038).
 *
 * Env: DATABASE_URL (local PG), CLOUD_INGRESS_URL (optional), SITE_ID, EDGE_PORT,
 * WEB_DIST (path to built clinic-web assets).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import pg from 'pg';
import { listPatients, stockForSku, doCheckout, syncStatus, syncPush, openCashierShift, closeShiftApi, type CheckoutApiBody, type CloseShiftApiBody } from './api.ts';
import { registerPatient, searchPatients, type RegisterBody } from './patients.ts';
import { mergePatients, unmergePatients } from './merge.ts';
import { recordVitals, type RecordVitalsBody } from './triage.ts';
import { ageingReport } from './debtors.ts';
import { createSlot, bookAppointment, nextAvailableSlot, setAppointmentStatus } from './scheduling.ts';
import { closePeriod, reopenPeriod, periodStatus } from './finance.ts';
import { trialBalance, incomeStatement } from './finance-reports.ts';
import { recordExpense, paySupplier, apReconciliation } from './payables.ts';
import { recordPayment, allocate, reallocate, invoiceOutstanding, refundPayment } from './billing.ts';
import { createOrder, releaseResult, acknowledgeCritical, outstandingCriticalResults, type ReleaseResultBody } from './orders.ts';
import { createDraftEncounter, updateDraft, signEncounter, addAddendum, markEnteredInError, getEncounter } from './encounters.ts';
import { receiveGoods, stockAlerts } from './inventory.ts';
import { performStocktake } from './stocktake.ts';
import { dashboard } from './management.ts';
import { searchAudit, exportAudit, type AuditFilter } from './audit.ts';
import { uploadDocument, openDocument, disclosureLog, type UploadBody } from './documents.ts';
import { startVisit, transfer, queueBoard, completeVisit } from './visits.ts';
import { setPreference, queueMessage, markSent, pendingMessages, type Purpose, type Channel } from './comms.ts';
import { addStaff, checkCredential, createTask, completeTask, overdueTasks } from './ops.ts';
import { VitalError, type AppointmentState } from '@sancta/domain';

const PORT = Number(process.env['EDGE_PORT'] ?? 8787);
const SITE_ID = process.env['SITE_ID'] ?? '00000000-0000-7000-8000-0000000000f1';
const CLOUD_INGRESS_URL = process.env['CLOUD_INGRESS_URL'] ?? '';
const WEB_DIST = process.env['WEB_DIST'] ?? '';

const pool = process.env['DATABASE_URL'] ? new pg.Pool({ connectionString: process.env['DATABASE_URL'] }) : undefined;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  if (!WEB_DIST) {
    sendJson(res, 404, { error: { code: 'not_found' } });
    return;
  }
  // Prevent path traversal; default to index.html for the SPA shell.
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB_DIST, safe);
  try {
    const content = await readFile(file);
    const ext = extname(file);
    // Static shell is versioned; the app data it fetches is always no-store.
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    try {
      const shell = await readFile(join(WEB_DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] as string });
      res.end(shell);
    } catch {
      sendJson(res, 404, { error: { code: 'not_found' } });
    }
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const p = url.pathname;
    try {
      if (p === '/api/management/dashboard' && req.method === 'GET') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
        return sendJson(res, 200, await dashboard(pool, asOf));
      }
      if (p === '/healthz') return sendJson(res, 200, { status: 'ok', plane: 'edge', offlineCapable: true });
      if (p === '/readyz') return sendJson(res, 200, { status: pool ? 'ready' : 'no-db' });

      if (p.startsWith('/api/')) {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        if (p === '/api/patients' && req.method === 'GET') {
          const q = url.searchParams.get('q');
          if (q) return sendJson(res, 200, { patients: await searchPatients(pool, q) });
          return sendJson(res, 200, { patients: await listPatients(pool) });
        }
        if (p === '/api/patients' && req.method === 'POST') {
          const body = (await readBody(req)) as RegisterBody;
          const out = await registerPatient(pool, body);
          return sendJson(res, out.ok ? 201 : 409, out);
        }
        if (p === '/api/patients/merge' && req.method === 'POST') {
          const b = (await readBody(req)) as { survivorId: string; mergedId: string; mergedBy: string };
          try { return sendJson(res, 200, await mergePatients(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'merge_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/patients/unmerge' && req.method === 'POST') {
          const b = (await readBody(req)) as { mergeId: string; user: string };
          try { return sendJson(res, 200, await unmergePatients(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'unmerge_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/stock' && req.method === 'GET') return sendJson(res, 200, await stockForSku(pool, url.searchParams.get('sku') ?? ''));
        if (p === '/api/stock/receive' && req.method === 'POST') {
          const b = (await readBody(req)) as { sku: string; expiryDate: string; unitCostMinor: number; quantity: number; supplier?: string; poRef?: string };
          try { return sendJson(res, 201, await receiveGoods(pool, b)); }
          catch (err) { return sendJson(res, 400, { error: { code: 'receipt_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/stock/alerts' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, { alerts: await stockAlerts(pool, asOf) });
        }
        if (p === '/api/stock/stocktake' && req.method === 'POST') {
          const b = (await readBody(req)) as { lotId: string; countedQty: number; approver?: string };
          try { return sendJson(res, 200, await performStocktake(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'stocktake_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/checkout' && req.method === 'POST') {
          const body = (await readBody(req)) as CheckoutApiBody;
          const out = await doCheckout(pool, body);
          return sendJson(res, out.ok ? 201 : 409, out);
        }
        if (p === '/api/encounters' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string };
          return sendJson(res, 201, await createDraftEncounter(pool, b));
        }
        if (p === '/api/encounters/draft' && req.method === 'POST') {
          const b = (await readBody(req)) as { encounterId: string; content: unknown };
          try { await updateDraft(pool, b); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 409, { error: { code: 'draft_locked', message: (err as Error).message } }); }
        }
        if (p === '/api/encounters/sign' && req.method === 'POST') {
          const b = (await readBody(req)) as { encounterId: string; signedBy: string; content?: unknown };
          try { return sendJson(res, 200, await signEncounter(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'sign_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/encounters/addendum' && req.method === 'POST') {
          const b = (await readBody(req)) as { encounterId: string; author: string; content: unknown };
          try { return sendJson(res, 201, await addAddendum(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'addendum_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/encounters/entered-in-error' && req.method === 'POST') {
          const b = (await readBody(req)) as { encounterId: string; user: string; reason: string };
          try { return sendJson(res, 200, await markEnteredInError(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'eie_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/encounters/get' && req.method === 'GET') {
          return sendJson(res, 200, await getEncounter(pool, url.searchParams.get('id') ?? ''));
        }
        if (p === '/api/orders' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; category: string; code: string; priority?: string; indication?: string; requestedBy?: string };
          return sendJson(res, 201, await createOrder(pool, b));
        }
        if (p === '/api/orders/result' && req.method === 'POST') {
          const b = (await readBody(req)) as ReleaseResultBody;
          return sendJson(res, 201, await releaseResult(pool, b));
        }
        if (p === '/api/orders/critical/ack' && req.method === 'POST') {
          const b = (await readBody(req)) as { resultId: string; acknowledgedBy: string; action?: string };
          return sendJson(res, 200, await acknowledgeCritical(pool, b));
        }
        if (p === '/api/orders/critical/outstanding' && req.method === 'GET') {
          return sendJson(res, 200, { results: await outstandingCriticalResults(pool) });
        }
        if (p === '/api/triage/vitals' && req.method === 'POST') {
          const body = (await readBody(req)) as RecordVitalsBody;
          try {
            return sendJson(res, 201, await recordVitals(pool, body));
          } catch (err) {
            if (err instanceof VitalError) return sendJson(res, 422, { error: { code: 'vitals_need_confirmation', message: err.message } });
            throw err;
          }
        }
        if (p === '/api/cashier/open' && req.method === 'POST') {
          const body = (await readBody(req)) as { cashier: string; site?: string; openingFloatMinor: number };
          return sendJson(res, 201, await openCashierShift(pool, body));
        }
        if (p === '/api/cashier/close' && req.method === 'POST') {
          const body = (await readBody(req)) as CloseShiftApiBody;
          try {
            return sendJson(res, 200, await closeShiftApi(pool, body));
          } catch (err) {
            // Variance over tolerance without approval, or shift not open.
            return sendJson(res, 409, { error: { code: 'shift_close_rejected', message: (err as Error).message } });
          }
        }
        if (p === '/api/schedule/slot' && req.method === 'POST') {
          const b = (await readBody(req)) as { provider: string; site?: string; startsAt: string; endsAt: string };
          return sendJson(res, 201, await createSlot(pool, b));
        }
        if (p === '/api/schedule/book' && req.method === 'POST') {
          const b = (await readBody(req)) as { slotId: string; patientId: string; serviceCode?: string; reason?: string };
          const out = await bookAppointment(pool, b);
          return sendJson(res, out.ok ? 201 : 409, out);
        }
        if (p === '/api/schedule/next' && req.method === 'GET') {
          const provider = url.searchParams.get('provider') ?? '';
          const afterIso = url.searchParams.get('after') ?? new Date().toISOString();
          return sendJson(res, 200, { slot: await nextAvailableSlot(pool, { provider, afterIso }) });
        }
        if (p === '/api/schedule/status' && req.method === 'POST') {
          const b = (await readBody(req)) as { appointmentId: string; to: AppointmentState };
          try {
            return sendJson(res, 200, await setAppointmentStatus(pool, b));
          } catch (err) {
            return sendJson(res, 409, { error: { code: 'illegal_transition', message: (err as Error).message } });
          }
        }
        if (p === '/api/visits/start' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; station?: string; priority?: number };
          return sendJson(res, 201, await startVisit(pool, b));
        }
        if (p === '/api/visits/transfer' && req.method === 'POST') {
          const b = (await readBody(req)) as { visitId: string; toStation: string; priority?: number };
          try { await transfer(pool, b); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 404, { error: { code: 'no_queue_entry', message: (err as Error).message } }); }
        }
        if (p === '/api/visits/queue' && req.method === 'GET') {
          return sendJson(res, 200, { queue: await queueBoard(pool, url.searchParams.get('station') ?? undefined) });
        }
        if (p === '/api/visits/complete' && req.method === 'POST') {
          const b = (await readBody(req)) as { visitId: string; override?: boolean; reason?: string; user?: string };
          const out = await completeVisit(pool, b);
          return sendJson(res, out.ok ? 200 : 409, out);
        }
        if (p === '/api/ops/staff' && req.method === 'POST') {
          const b = (await readBody(req)) as { fullName: string; role: string; registrationNo?: string; credentialExpiry?: string };
          return sendJson(res, 201, await addStaff(pool, b));
        }
        if (p === '/api/ops/credential' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          try { return sendJson(res, 200, await checkCredential(pool, url.searchParams.get('staffId') ?? '', asOf)); }
          catch (err) { return sendJson(res, 404, { error: { code: 'staff_not_found', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/task' && req.method === 'POST') {
          const b = (await readBody(req)) as { subject: string; owner?: string; priority?: number; dueDate?: string };
          return sendJson(res, 201, await createTask(pool, b));
        }
        if (p === '/api/ops/task/complete' && req.method === 'POST') {
          const b = (await readBody(req)) as { taskId: string };
          try { await completeTask(pool, b.taskId); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 409, { error: { code: 'task_not_open', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/tasks/overdue' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, { tasks: await overdueTasks(pool, asOf) });
        }
        if (p === '/api/comms/preference' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; purpose: Purpose; channel: Channel; allowed: boolean };
          await setPreference(pool, b); return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/comms/message' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; purpose: Purpose; channel: Channel; template: string; dedupKey: string };
          return sendJson(res, 201, await queueMessage(pool, b));
        }
        if (p === '/api/comms/sent' && req.method === 'POST') {
          const b = (await readBody(req)) as { messageId: string };
          try { await markSent(pool, b.messageId); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 409, { error: { code: 'not_sendable', message: (err as Error).message } }); }
        }
        if (p === '/api/comms/pending' && req.method === 'GET') {
          return sendJson(res, 200, { messages: await pendingMessages(pool) });
        }
        if (p === '/api/documents' && req.method === 'POST') {
          const b = (await readBody(req)) as UploadBody;
          return sendJson(res, 201, await uploadDocument(pool, b));
        }
        if (p === '/api/documents/open' && req.method === 'POST') {
          const b = (await readBody(req)) as { documentId: string; userId: string; purpose?: string };
          try { return sendJson(res, 200, await openDocument(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'document_unavailable', message: (err as Error).message } }); }
        }
        if (p === '/api/documents/disclosures' && req.method === 'GET') {
          return sendJson(res, 200, { disclosures: await disclosureLog(pool, url.searchParams.get('id') ?? '') });
        }
        if (p === '/api/audit/search' && req.method === 'GET') {
          const f: AuditFilter = {
            ...(url.searchParams.get('user') ? { user: url.searchParams.get('user') as string } : {}),
            ...(url.searchParams.get('patientRef') ? { patientRef: url.searchParams.get('patientRef') as string } : {}),
            ...(url.searchParams.get('resourceType') ? { resourceType: url.searchParams.get('resourceType') as string } : {}),
            ...(url.searchParams.get('action') ? { action: url.searchParams.get('action') as string } : {}),
          };
          return sendJson(res, 200, { events: await searchAudit(pool, f) });
        }
        if (p === '/api/audit/export' && req.method === 'POST') {
          const b = (await readBody(req)) as { filter: AuditFilter; exportedBy: string };
          return sendJson(res, 200, await exportAudit(pool, b.filter ?? {}, b.exportedBy));
        }
        if (p === '/api/debtors/ageing' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, await ageingReport(pool, asOf));
        }
        if (p === '/api/billing/payment' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; method: 'cash' | 'bank' | 'mobile'; amountMinor: number };
          try { return sendJson(res, 201, await recordPayment(pool, b)); }
          catch (err) { return sendJson(res, 400, { error: { code: 'payment_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/allocate' && req.method === 'POST') {
          const b = (await readBody(req)) as { paymentId: string; allocations: Array<{ invoiceId: string; amountMinor: number }> };
          try { await allocate(pool, b); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 409, { error: { code: 'allocation_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/reallocate' && req.method === 'POST') {
          const b = (await readBody(req)) as { paymentId: string; fromInvoiceId: string; toInvoiceId: string; amountMinor: number };
          try { await reallocate(pool, b); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 409, { error: { code: 'reallocation_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/refund' && req.method === 'POST') {
          const b = (await readBody(req)) as { paymentId: string; amountMinor: number; method: 'cash' | 'bank' | 'mobile'; reason: string; approver?: string };
          try { return sendJson(res, 201, await refundPayment(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'refund_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/invoice-outstanding' && req.method === 'GET') {
          const id = url.searchParams.get('id') ?? '';
          return sendJson(res, 200, { invoiceId: id, outstandingMinor: await invoiceOutstanding(pool, id) });
        }
        if (p === '/api/finance/period/close' && req.method === 'POST') {
          const b = (await readBody(req)) as { periodId: string; approver?: string };
          try { return sendJson(res, 200, await closePeriod(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'period_close_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/period/reopen' && req.method === 'POST') {
          const b = (await readBody(req)) as { periodId: string; approver?: string; reason?: string };
          try { return sendJson(res, 200, await reopenPeriod(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'period_reopen_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/expense' && req.method === 'POST') {
          const b = (await readBody(req)) as { category: string; supplier?: string; amountMinor: number; approver?: string; dueDate?: string };
          try { return sendJson(res, 201, await recordExpense(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'expense_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/pay-supplier' && req.method === 'POST') {
          const b = (await readBody(req)) as { payableId: string; method?: 'cash' | 'bank' };
          try { return sendJson(res, 200, await paySupplier(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'payment_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/ap-reconciliation' && req.method === 'GET') {
          return sendJson(res, 200, await apReconciliation(pool));
        }
        if (p === '/api/finance/trial-balance' && req.method === 'GET') {
          return sendJson(res, 200, await trialBalance(pool));
        }
        if (p === '/api/finance/income-statement' && req.method === 'GET') {
          return sendJson(res, 200, await incomeStatement(pool));
        }
        if (p === '/api/finance/period' && req.method === 'GET') {
          const id = url.searchParams.get('id') ?? '';
          return sendJson(res, 200, { periodId: id, status: await periodStatus(pool, id) });
        }
        if (p === '/api/sync/status' && req.method === 'GET') return sendJson(res, 200, await syncStatus(pool));
        if (p === '/api/sync/push' && req.method === 'POST') {
          if (!CLOUD_INGRESS_URL) return sendJson(res, 200, { attempted: 0, acknowledged: 0, failed: 0, deferred: 0, note: 'no cloud configured' });
          return sendJson(res, 200, await syncPush(pool, CLOUD_INGRESS_URL, SITE_ID));
        }
        return sendJson(res, 404, { error: { code: 'not_found' } });
      }

      return await serveStatic(res, p);
    } catch (e) {
      const cid = 'edge-' + Date.now().toString(36);
      // Never leak internals or PHI (NFR-018/026).
      sendJson(res, 500, { error: { code: 'internal', correlationId: cid } });
    }
  })();
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`sancta clinic-edge on http://0.0.0.0:${PORT} (offline-capable; cloud=${CLOUD_INGRESS_URL || 'none'})`);
  });
}

export { server, pool };
