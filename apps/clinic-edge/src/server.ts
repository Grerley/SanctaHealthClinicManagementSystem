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
import { listPolicy, setFieldRule } from './demographics.ts';
import { changeDemographic, markDeceased, patientIdentityHistory } from './identity-history.ts';
import { integrationQueueStatus, deadLetters, replayDeadLetter, type Deliver } from './integration-queue.ts';
import { fhirPatientById, fhirPatientSearch } from './fhir.ts';
import { toFhirBundle, capabilityStatement } from '@sancta/domain';
import { instanceInfo } from './instance.ts';
import { defineForm, listForms, formAsOf } from './forms.ts';
import { patientTimeline, type TimelineItem } from './timeline.ts';
import { mergePatients, unmergePatients } from './merge.ts';
import { recordAllergy, prescribe } from './prescribing.ts';
import { registerDevice, revokeDevice, isDeviceTrusted } from './devices.ts';
import { recordVitals, recordTriageAssessment, recordIntervention, signTriage, openTriageQueue, triageSummary, TriageError, type RecordVitalsBody } from './triage.ts';
import { ageingReport } from './debtors.ts';
import { createSlot, bookAppointment, nextAvailableSlot, setAppointmentStatus } from './scheduling.ts';
import { closePeriod, reopenPeriod, periodStatus } from './finance.ts';
import { trialBalance, incomeStatement } from './finance-reports.ts';
import { draftManualJournal, approveManualJournal, rejectManualJournal, listManualJournals } from './manual-journal.ts';
import { balanceSheet, monthlyClose } from './finance-close.ts';
import { createCostCentre, listCostCentres, defineAccount, reviseAccount, accountAsOf, chartOfAccounts, createDimension, addDimensionValue, listDimensions } from './chart.ts';
import { quotePrice, chargeService, defineFee, listFees } from './pricing.ts';
import { recordExpense, paySupplier, apReconciliation } from './payables.ts';
import { recordPayment, allocate, reallocate, invoiceOutstanding, refundPayment } from './billing.ts';
import { markBillable, linkCharge, authoriseException, chargeCaptureReport, type ChargeException } from './billing-completeness.ts';
import { createOrder, releaseResult, acknowledgeCritical, outstandingCriticalResults, type ReleaseResultBody } from './orders.ts';
import { createDraftEncounter, updateDraft, signEncounter, addAddendum, markEnteredInError, getEncounter, attachForm } from './encounters.ts';
import { receiveGoods, stockAlerts } from './inventory.ts';
import { performStocktake } from './stocktake.ts';
import { dashboard, exportDashboard } from './management.ts';
import { applyDemographicUpdate, resolveConflictCase, listOpenConflicts } from './conflict.ts';
import { searchAudit, exportAudit, type AuditFilter } from './audit.ts';
import { uploadDocument, openDocument, disclosureLog, type UploadBody } from './documents.ts';
import { startVisit, transfer, queueBoard, completeVisit } from './visits.ts';
import { setPreference, queueMessage, markSent, pendingMessages, type Purpose, type Channel } from './comms.ts';
import { addStaff, checkCredential, createTask, completeTask, overdueTasks } from './ops.ts';
import { addResource, setResourceStatus, listResources, availableCapacity, defineChecklist, runChecklist, reportIncident, updateIncident, openIncidents, scheduleMaintenance, completeMaintenance, dueMaintenance } from './facility.ts';
import { VitalError, type AppointmentState } from '@sancta/domain';
import { authFromHeaders, checkAuthorised } from './http-auth.ts';

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
      // Central deny-by-default authorisation for every protected /api/ route (ADM-001).
      if (p.startsWith('/api/')) {
        const ctx = authFromHeaders(req.headers as Record<string, string | string[] | undefined>);
        const missing = checkAuthorised(ctx, req.method ?? 'GET', p);
        if (missing) return sendJson(res, 403, { error: { code: 'forbidden', message: `permission required: ${missing}` } });
      }
      if (p === '/api/management/dashboard' && req.method === 'GET') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
        return sendJson(res, 200, await dashboard(pool, asOf));
      }
      if (p === '/api/management/export' && req.method === 'POST') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const b = (await readBody(req)) as { asOf?: string; exportedBy: string; filters?: Record<string, string>; format?: 'json' | 'csv' | 'pdf' };
        // Authorisation ('export') is enforced by the central guard above.
        return sendJson(res, 200, await exportDashboard(pool, { asOf: b.asOf ?? new Date().toISOString().slice(0, 10), exportedBy: b.exportedBy, ...(b.filters ? { filters: b.filters } : {}), ...(b.format ? { format: b.format } : {}) }));
      }
      if (p === '/healthz') {
        const inst = instanceInfo();
        return sendJson(res, 200, { status: 'ok', plane: 'edge', offlineCapable: true, mode: inst.mode, nonProduction: inst.nonProduction, banner: inst.banner });
      }
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
          try {
            const out = await registerPatient(pool, body);
            return sendJson(res, out.ok ? 201 : 409, out);
          } catch (err) {
            return sendJson(res, 422, { error: { code: 'demographics_invalid', message: (err as Error).message } });
          }
        }
        if (p === '/api/patients/history' && req.method === 'GET') {
          return sendJson(res, 200, { history: await patientIdentityHistory(pool, url.searchParams.get('patientId') ?? '') });
        }
        if (p === '/api/patients/demographic' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof changeDemographic>[1];
          try { return sendJson(res, 200, await changeDemographic(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'demographic_change_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/patients/deceased' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof markDeceased>[1];
          try { return sendJson(res, 200, await markDeceased(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'deceased_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/patients/policy' && req.method === 'GET') {
          return sendJson(res, 200, { fields: await listPolicy(pool) });
        }
        if (p === '/api/instance' && req.method === 'GET') {
          return sendJson(res, 200, instanceInfo());
        }
        if (p === '/api/fhir/metadata' && req.method === 'GET') {
          return sendJson(res, 200, capabilityStatement('0.1.0'));
        }
        if (p === '/api/fhir/Patient' && req.method === 'GET') {
          const id = url.searchParams.get('id');
          const identifier = url.searchParams.get('identifier');
          if (id) {
            const resource = await fhirPatientById(pool, id);
            if (!resource) return sendJson(res, 404, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
            return sendJson(res, 200, resource);
          }
          return sendJson(res, 200, toFhirBundle(await fhirPatientSearch(pool, identifier ?? '')));
        }
        if (p === '/api/patients/policy' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setFieldRule>[1];
          try { return sendJson(res, 200, await setFieldRule(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'policy_rejected', message: (err as Error).message } }); }
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
        if (p === '/api/encounters/attach-form' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof attachForm>[1];
          try { return sendJson(res, 200, await attachForm(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'attach_form_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/forms' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? undefined;
          return sendJson(res, 200, { forms: await listForms(pool, asOf) });
        }
        if (p === '/api/forms/get' && req.method === 'GET') {
          const code = url.searchParams.get('formCode') ?? '';
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          try { return sendJson(res, 200, await formAsOf(pool, code, asOf)); }
          catch (err) { return sendJson(res, 404, { error: { code: 'form_not_found', message: (err as Error).message } }); }
        }
        if (p === '/api/forms' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof defineForm>[1];
          try { return sendJson(res, 201, await defineForm(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'form_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/patients/timeline' && req.method === 'GET') {
          const patientId = url.searchParams.get('patientId') ?? '';
          const type = (url.searchParams.get('type') ?? undefined) as TimelineItem['type'] | undefined;
          const from = url.searchParams.get('from') ?? undefined;
          const to = url.searchParams.get('to') ?? undefined;
          return sendJson(res, 200, { timeline: await patientTimeline(pool, patientId, { ...(type ? { type } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }) });
        }
        if (p === '/api/allergies' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; substanceCode: string; severity?: 'low' | 'high' | 'critical' };
          return sendJson(res, 201, await recordAllergy(pool, b));
        }
        if (p === '/api/prescribe' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof prescribe>[1];
          try {
            const out = await prescribe(pool, b);
            return sendJson(res, out.ok ? 201 : 409, out);
          } catch (err) { return sendJson(res, 422, { error: { code: 'prescribe_rejected', message: (err as Error).message } }); }
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
        if (p === '/api/triage/assessment' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof recordTriageAssessment>[1];
          try { return sendJson(res, 201, await recordTriageAssessment(pool, b)); }
          catch (err) { if (err instanceof TriageError) return sendJson(res, 422, { error: { code: 'triage_rejected', message: err.message } }); throw err; }
        }
        if (p === '/api/triage/intervention' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof recordIntervention>[1];
          try { return sendJson(res, 201, await recordIntervention(pool, b)); }
          catch (err) { if (err instanceof TriageError) return sendJson(res, 422, { error: { code: 'intervention_rejected', message: err.message } }); throw err; }
        }
        if (p === '/api/triage/sign' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof signTriage>[1];
          try { return sendJson(res, 200, await signTriage(pool, b)); }
          catch (err) { if (err instanceof TriageError) return sendJson(res, 409, { error: { code: 'triage_sign_rejected', message: err.message } }); throw err; }
        }
        if (p === '/api/triage/queue' && req.method === 'GET') {
          return sendJson(res, 200, { queue: await openTriageQueue(pool) });
        }
        if (p === '/api/triage/summary' && req.method === 'GET') {
          return sendJson(res, 200, await triageSummary(pool, url.searchParams.get('encounterId') ?? ''));
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
        if (p === '/api/devices' && req.method === 'POST') {
          const b = (await readBody(req)) as { label: string; site?: string; softwareVersion?: string };
          return sendJson(res, 201, await registerDevice(pool, b));
        }
        if (p === '/api/devices/revoke' && req.method === 'POST') {
          const b = (await readBody(req)) as { deviceId: string; user?: string };
          try { await revokeDevice(pool, b); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 404, { error: { code: 'device_not_found', message: (err as Error).message } }); }
        }
        if (p === '/api/devices/trusted' && req.method === 'GET') {
          return sendJson(res, 200, { trusted: await isDeviceTrusted(pool, url.searchParams.get('id') ?? '') });
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
        // Facility resources (OPS-002)
        if (p === '/api/ops/resource' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof addResource>[1];
          try { return sendJson(res, 201, await addResource(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'resource_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/resource/status' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setResourceStatus>[1];
          try { return sendJson(res, 200, await setResourceStatus(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'resource_status_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/resources' && req.method === 'GET') {
          return sendJson(res, 200, { resources: await listResources(pool, url.searchParams.get('kind') ?? undefined) });
        }
        if (p === '/api/ops/capacity' && req.method === 'GET') {
          return sendJson(res, 200, await availableCapacity(pool, url.searchParams.get('kind') ?? 'room'));
        }
        // Checklists (OPS-004)
        if (p === '/api/ops/checklist' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof defineChecklist>[1];
          try { return sendJson(res, 201, await defineChecklist(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'checklist_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/checklist/run' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof runChecklist>[1];
          try { return sendJson(res, 201, await runChecklist(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'checklist_run_rejected', message: (err as Error).message } }); }
        }
        // Incidents (OPS-005)
        if (p === '/api/ops/incident' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof reportIncident>[1];
          try { return sendJson(res, 201, await reportIncident(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'incident_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/incident/update' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof updateIncident>[1];
          try { return sendJson(res, 200, await updateIncident(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'incident_update_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/incidents' && req.method === 'GET') {
          return sendJson(res, 200, { incidents: await openIncidents(pool) });
        }
        // Maintenance (OPS-006)
        if (p === '/api/ops/maintenance' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof scheduleMaintenance>[1];
          try { return sendJson(res, 201, await scheduleMaintenance(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'maintenance_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/maintenance/complete' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof completeMaintenance>[1];
          try { return sendJson(res, 200, await completeMaintenance(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'maintenance_complete_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ops/maintenance/due' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, { due: await dueMaintenance(pool, asOf) });
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
        if (p === '/api/billing/mark-billable' && req.method === 'POST') {
          const b = (await readBody(req)) as { encounterId: string };
          try { await markBillable(pool, b.encounterId); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 404, { error: { code: 'not_found', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/link-charge' && req.method === 'POST') {
          const b = (await readBody(req)) as { encounterId: string; invoiceId: string };
          try { await linkCharge(pool, b); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 404, { error: { code: 'not_found', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/charge-exception' && req.method === 'POST') {
          const b = (await readBody(req)) as { encounterId: string; outcome: ChargeException; reason: string; approver: string };
          try { await authoriseException(pool, b); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 409, { error: { code: 'exception_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/charge-capture' && req.method === 'GET') {
          return sendJson(res, 200, await chargeCaptureReport(pool));
        }
        if (p === '/api/billing/price' && req.method === 'GET') {
          const serviceCode = url.searchParams.get('serviceCode') ?? '';
          const onDate = url.searchParams.get('onDate') ?? new Date().toISOString().slice(0, 10);
          const appliedRaw = url.searchParams.get('appliedMinor');
          try {
            return sendJson(res, 200, await quotePrice(pool, { serviceCode, onDate, ...(appliedRaw ? { appliedMinor: Number(appliedRaw) } : {}), ...(url.searchParams.get('reason') ? { reason: url.searchParams.get('reason') as string } : {}), ...(url.searchParams.get('approver') ? { approver: url.searchParams.get('approver') as string } : {}) }));
          } catch (err) { return sendJson(res, 409, { error: { code: 'price_unavailable', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/charge' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof chargeService>[1];
          try { return sendJson(res, 201, await chargeService(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'charge_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/fees' && req.method === 'GET') {
          const sc = url.searchParams.get('serviceCode') ?? undefined;
          return sendJson(res, 200, { fees: await listFees(pool, sc) });
        }
        if (p === '/api/billing/fee' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof defineFee>[1];
          try { return sendJson(res, 201, await defineFee(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'fee_rejected', message: (err as Error).message } }); }
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
        if (p === '/api/finance/balance-sheet' && req.method === 'GET') {
          return sendJson(res, 200, await balanceSheet(pool));
        }
        if (p === '/api/finance/chart' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, { asOf, accounts: await chartOfAccounts(pool, asOf) });
        }
        if (p === '/api/finance/account' && req.method === 'GET') {
          const code = url.searchParams.get('code') ?? '';
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          try { return sendJson(res, 200, await accountAsOf(pool, code, asOf)); }
          catch (err) { return sendJson(res, 404, { error: { code: 'account_not_found', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/account' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof defineAccount>[1];
          try { return sendJson(res, 201, await defineAccount(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'account_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/account/revise' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof reviseAccount>[1];
          try { return sendJson(res, 200, await reviseAccount(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'account_revise_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/cost-centres' && req.method === 'GET') {
          return sendJson(res, 200, { costCentres: await listCostCentres(pool) });
        }
        if (p === '/api/finance/cost-centre' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof createCostCentre>[1];
          try { return sendJson(res, 201, await createCostCentre(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'cost_centre_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/dimensions' && req.method === 'GET') {
          return sendJson(res, 200, { dimensions: await listDimensions(pool) });
        }
        if (p === '/api/finance/dimension' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof createDimension>[1];
          try { return sendJson(res, 201, await createDimension(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'dimension_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/dimension/value' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof addDimensionValue>[1];
          try { return sendJson(res, 201, await addDimensionValue(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'dimension_value_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/journal' && req.method === 'GET') {
          const st = url.searchParams.get('status') ?? undefined;
          return sendJson(res, 200, { journals: await listManualJournals(pool, st) });
        }
        if (p === '/api/finance/journal/draft' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof draftManualJournal>[1];
          try { return sendJson(res, 201, await draftManualJournal(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'journal_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/journal/post' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof approveManualJournal>[1];
          try { return sendJson(res, 200, await approveManualJournal(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'journal_post_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/journal/reject' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof rejectManualJournal>[1];
          try { return sendJson(res, 200, await rejectManualJournal(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'journal_reject_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/monthly-close' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof monthlyClose>[1];
          try { return sendJson(res, 200, await monthlyClose(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'monthly_close_rejected', message: (err as Error).message } }); }
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
        if (p === '/api/integrations/status' && req.method === 'GET') return sendJson(res, 200, await integrationQueueStatus(pool));
        if (p === '/api/integrations/dead' && req.method === 'GET') return sendJson(res, 200, { deadLetters: await deadLetters(pool) });
        if (p === '/api/integrations/replay' && req.method === 'POST') {
          const b = (await readBody(req)) as { id: string; by: string };
          // Delivery is the cloud plane's responsibility; the edge hands off when connected.
          const deliver: Deliver = async () => { if (!CLOUD_INGRESS_URL) throw new Error('cloud not configured; integration remains queued'); };
          try { return sendJson(res, 200, await replayDeadLetter(pool, b, deliver)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'replay_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/sync/conflicts' && req.method === 'GET') return sendJson(res, 200, { conflicts: await listOpenConflicts(pool) });
        if (p === '/api/sync/demographic-update' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof applyDemographicUpdate>[1];
          try { return sendJson(res, 200, await applyDemographicUpdate(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'demographic_update_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/sync/conflicts/resolve' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof resolveConflictCase>[1];
          try { return sendJson(res, 200, await resolveConflictCase(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'conflict_resolve_rejected', message: (err as Error).message } }); }
        }
        return sendJson(res, 404, { error: { code: 'not_found' } });
      }

      return await serveStatic(res, p);
    } catch (e) {
      const cid = 'edge-' + Date.now().toString(36);
      // Log server-side for support (no PHI, NFR-025); never leak internals to the client (NFR-018/026).
      // eslint-disable-next-line no-console
      console.error(`[${cid}]`, e instanceof Error ? e.stack : e);
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
