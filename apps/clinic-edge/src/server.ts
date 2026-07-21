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
import { addRelatedPerson, listRelatedPersons, accessPatient } from './patient-relations.ts';
import { integrationQueueStatus, deadLetters, replayDeadLetter, type Deliver } from './integration-queue.ts';
import { fhirPatientById, fhirPatientSearch } from './fhir.ts';
import { toFhirBundle, capabilityStatement } from '@sancta/domain';
import { instanceInfo } from './instance.ts';
import { registerSite, listSitesForUser } from './site.ts';
import { setKpiTarget, recordSnapshot, kpiComparison } from './kpi.ts';
import { createRelease, promoteRelease, rollbackRelease, currentConfig, setFeatureFlag, evaluateFlag, systemHealth } from './admin.ts';
import { defineForm, listForms, formAsOf } from './forms.ts';
import { patientTimeline, type TimelineItem } from './timeline.ts';
import { addHistoryItem, setHistoryStatus, listHistory, searchDiagnosisCodes, recordDiagnosis, listDiagnoses, openDraftEncounter, autosaveDraft } from './ehr.ts';
import { createCarePlan, addGoal, addFollowUp, completeFollowUp, listCarePlans, overdueFollowUps } from './care-plan.ts';
import { generateVisitSummary, generatePrescription, generateSickNote, generateReferral } from './docgen.ts';
import { sendHandover, acknowledgeHandover, inbox } from './handover.ts';
import { mergePatients, unmergePatients } from './merge.ts';
import { recordAllergy, prescribe, defineRxTemplate, applyRxTemplate, recordAdministration, listAdministrations } from './prescribing.ts';
import { searchFormulary, dispensingWorklist, markDispensed, generatePrescription as generateMedPrescription } from './medication.ts';
import { registerDevice, revokeDevice, isDeviceTrusted } from './devices.ts';
import { recordVitals, recordTriageAssessment, recordIntervention, signTriage, openTriageQueue, triageSummary, TriageError, type RecordVitalsBody } from './triage.ts';
import { ageingReport } from './debtors.ts';
import { createSlot, bookAppointment, nextAvailableSlot, setAppointmentStatus, addToWaitlist, fillReleasedSlot, queueReminder, setAppointmentType, resolveAppointmentType } from './scheduling.ts';
import { appointmentReminder } from '@sancta/domain';
import { closePeriod, reopenPeriod, periodStatus } from './finance.ts';
import { trialBalance, incomeStatement, exportApprovedLedger } from './finance-reports.ts';
import { breakEven, investmentRecovery } from '@sancta/domain';
import { draftManualJournal, approveManualJournal, rejectManualJournal, listManualJournals } from './manual-journal.ts';
import { balanceSheet, monthlyClose } from './finance-close.ts';
import { setBudget, budgetVariance } from './finance-budget.ts';
import { createCostCentre, listCostCentres, defineAccount, reviseAccount, accountAsOf, chartOfAccounts, createDimension, addDimensionValue, listDimensions } from './chart.ts';
import { quotePrice, chargeService, defineFee, listFees } from './pricing.ts';
import { recordExpense, paySupplier, apReconciliation } from './payables.ts';
import { recordPayment, allocate, reallocate, invoiceOutstanding, refundPayment } from './billing.ts';
import { markBillable, linkCharge, authoriseException, chargeCaptureReport, type ChargeException } from './billing-completeness.ts';
import { createOrder, releaseResult, acknowledgeCritical, outstandingCriticalResults, attachExternalResult, reconcileExternalResult, unmatchedResults, cancelOrder, correctResult, defineOrderSet, applyOrderSet, generateSpecimenLabel, createReferral, updateReferral, listOpenReferrals, type ReleaseResultBody } from './orders.ts';
import { createDraftEncounter, updateDraft, signEncounter, addAddendum, markEnteredInError, getEncounter, attachForm } from './encounters.ts';
import { receiveGoods, stockAlerts } from './inventory.ts';
import { createRequisition, decideRequisition, createPurchaseOrder, registerEquipment, recordEquipmentService, equipmentDueService } from './procurement.ts';
import { performStocktake } from './stocktake.ts';
import { reorderSuggestions, stockMovementReport } from './inventory-reports.ts';
import { dashboard, exportDashboard, resolveSiteScope, drillThrough, addCommentary, listCommentary, ManagementScopeError } from './management.ts';
import { publicQueue, analyticalExtract, exportPatientSummary, listPatientDisclosures, DisclosureError } from './privacy.ts';
import { patientCard, resolveCard, checkInView } from './frontdesk.ts';
import { applyDemographicUpdate, resolveConflictCase, listOpenConflicts } from './conflict.ts';
import { searchAudit, exportAudit, type AuditFilter } from './audit.ts';
import { uploadDocument, openDocument, disclosureLog, indexDocument, searchDocuments, type UploadBody } from './documents.ts';
import { printReceipt, printInvoice, printStatement } from './billing-print.ts';
import { storeGeneratedDocument, supersedeDocument, markDocumentEnteredInError, setLegalHold, setRetention, disposalCandidates, disposeDocument } from './document-lifecycle.ts';
import { startVisit, transfer, queueBoard, completeVisit } from './visits.ts';
import { escalateVisit, holdVisit, resumeVisit, endVisitWithOutcome, visitDurations } from './visit-lifecycle.ts';
import { setPreference, queueMessage, markSent, pendingMessages, type Purpose, type Channel } from './comms.ts';
import { addStaff, checkCredential, createTask, completeTask, overdueTasks, staffProductivity } from './ops.ts';
import { addResource, setResourceStatus, listResources, availableCapacity, defineChecklist, runChecklist, reportIncident, updateIncident, openIncidents, scheduleMaintenance, completeMaintenance, dueMaintenance } from './facility.ts';
import { VitalError, type AppointmentState, type DrillTarget } from '@sancta/domain';
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
      const ctx = authFromHeaders(req.headers as Record<string, string | string[] | undefined>);
      if (p.startsWith('/api/')) {
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
      if (p === '/api/management/kpi-target' && req.method === 'POST') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const b = (await readBody(req)) as Parameters<typeof setKpiTarget>[1];
        try { return sendJson(res, 201, await setKpiTarget(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'kpi_target_rejected', message: (err as Error).message } }); }
      }
      if (p === '/api/management/kpi-snapshot' && req.method === 'POST') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const b = (await readBody(req)) as Parameters<typeof recordSnapshot>[1];
        return sendJson(res, 201, await recordSnapshot(pool, b));
      }
      if (p === '/api/management/kpi-comparison' && req.method === 'GET') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        try { return sendJson(res, 200, await kpiComparison(pool, { kpiId: url.searchParams.get('kpiId') ?? '', period: url.searchParams.get('period') ?? '', priorPeriod: url.searchParams.get('priorPeriod') ?? '' })); }
        catch (err) { return sendJson(res, 404, { error: { code: 'kpi_comparison_unavailable', message: (err as Error).message } }); }
      }
      if (p === '/api/management/scope' && req.method === 'GET') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const siteHeader = req.headers['x-site'];
        const userSite = Array.isArray(siteHeader) ? siteHeader[0] ?? null : siteHeader ?? null;
        const requested = url.searchParams.getAll('site');
        return sendJson(res, 200, await resolveSiteScope(pool, { roles: ctx.roles, userSite, requestedSites: requested }));
      }
      if (p === '/api/management/drill' && req.method === 'GET') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const target = url.searchParams.get('target') as DrillTarget;
        try { return sendJson(res, 200, await drillThrough(pool, { roles: ctx.roles, target, ...(ctx.user ? { actor: ctx.user } : {}) })); }
        catch (err) { return sendJson(res, 403, { error: { code: 'drill_forbidden', message: (err as Error).message } }); }
      }
      if (p === '/api/management/commentary' && req.method === 'GET') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        return sendJson(res, 200, { commentary: await listCommentary(pool, { kpiId: url.searchParams.get('kpiId') ?? '', period: url.searchParams.get('period') ?? '' }) });
      }
      if (p === '/api/management/commentary' && req.method === 'POST') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const b = (await readBody(req)) as Parameters<typeof addCommentary>[1];
        try { return sendJson(res, 201, await addCommentary(pool, { ...b, ...(ctx.user ? { authoredBy: ctx.user } : {}) })); }
        catch (err) { if (err instanceof ManagementScopeError) return sendJson(res, 400, { error: { code: 'commentary_rejected', message: err.message } }); throw err; }
      }
      if (p === '/api/management/analytical-extract' && req.method === 'GET') {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
        return sendJson(res, 200, await analyticalExtract(pool, { asOf, ...(ctx.user ? { exportedBy: ctx.user } : {}) }));
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
        if (p === '/api/patients/related' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof addRelatedPerson>[1];
          try { return sendJson(res, 201, await addRelatedPerson(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'related_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/patients/related' && req.method === 'GET') {
          return sendJson(res, 200, { related: await listRelatedPersons(pool, url.searchParams.get('patientId') ?? '') });
        }
        if (p === '/api/patients/access' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; purpose?: string; breakGlass?: boolean; breakGlassReason?: string };
          try { return sendJson(res, 200, await accessPatient(pool, { patientId: b.patientId, roles: ctx.roles, user: ctx.user ?? 'unknown', ...(b.purpose ? { purpose: b.purpose } : {}), ...(b.breakGlass ? { breakGlass: true } : {}), ...(b.breakGlassReason ? { breakGlassReason: b.breakGlassReason } : {}) })); }
          catch (err) { return sendJson(res, 403, { error: { code: 'access_denied', message: (err as Error).message } }); }
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
        if (p === '/api/sites' && req.method === 'GET') {
          const siteHeader = req.headers['x-site'];
          const userSite = Array.isArray(siteHeader) ? siteHeader[0] ?? null : siteHeader ?? null;
          return sendJson(res, 200, { sites: await listSitesForUser(pool, ctx.roles, userSite) });
        }
        if (p === '/api/sites' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof registerSite>[1];
          try { return sendJson(res, 201, await registerSite(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'site_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/admin/health' && req.method === 'GET') {
          return sendJson(res, 200, await systemHealth(pool));
        }
        if (p === '/api/admin/config-release' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof createRelease>[1];
          try { return sendJson(res, 201, await createRelease(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'release_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/admin/config-release/promote' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof promoteRelease>[1];
          try { return sendJson(res, 200, await promoteRelease(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'promote_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/admin/config-release/rollback' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof rollbackRelease>[1];
          try { return sendJson(res, 200, await rollbackRelease(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'rollback_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/admin/config' && req.method === 'GET') {
          return sendJson(res, 200, { config: await currentConfig(pool, url.searchParams.get('name') ?? '') });
        }
        if (p === '/api/admin/feature-flag' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setFeatureFlag>[1];
          return sendJson(res, 200, await setFeatureFlag(pool, b));
        }
        if (p === '/api/admin/feature-flag' && req.method === 'GET') {
          const key = url.searchParams.get('key') ?? '';
          const siteHeader = req.headers['x-site'];
          const site = Array.isArray(siteHeader) ? siteHeader[0] ?? null : siteHeader ?? null;
          return sendJson(res, 200, { key, enabled: await evaluateFlag(pool, key, { site, roles: ctx.roles }) });
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
        if (p === '/api/procurement/requisition' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof createRequisition>[1];
          try { return sendJson(res, 201, await createRequisition(pool, { ...b, ...(ctx.user ? { requestedBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 400, { error: { code: 'requisition_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/procurement/requisition/decide' && req.method === 'POST') {
          const b = (await readBody(req)) as { requisitionId: string; approve: boolean };
          try { return sendJson(res, 200, await decideRequisition(pool, { requisitionId: b.requisitionId, approve: b.approve, approver: ctx.user ?? '', approverRoles: ctx.roles })); }
          catch (err) { return sendJson(res, 409, { error: { code: 'requisition_decision_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/procurement/purchase-order' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof createPurchaseOrder>[1];
          try { return sendJson(res, 201, await createPurchaseOrder(pool, { ...b, ...(ctx.user ? { createdBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 409, { error: { code: 'purchase_order_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/equipment' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof registerEquipment>[1];
          try { return sendJson(res, 201, await registerEquipment(pool, b)); } catch (err) { return sendJson(res, 400, { error: { code: 'equipment_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/equipment/service' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof recordEquipmentService>[1];
          try { return sendJson(res, 201, await recordEquipmentService(pool, { ...b, ...(ctx.user ? { performedBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 404, { error: { code: 'equipment_service_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/equipment/due' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, { equipment: await equipmentDueService(pool, { asOf }) });
        }
        if (p === '/api/stock/stocktake' && req.method === 'POST') {
          const b = (await readBody(req)) as { lotId: string; countedQty: number; approver?: string };
          try { return sendJson(res, 200, await performStocktake(pool, b)); }
          catch (err) { return sendJson(res, 409, { error: { code: 'stocktake_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/stock/reorder' && req.method === 'GET') {
          return sendJson(res, 200, { suggestions: await reorderSuggestions(pool) });
        }
        if (p === '/api/stock/movement-report' && req.method === 'GET') {
          const from = url.searchParams.get('from') ?? '2026-01-01';
          const to = url.searchParams.get('to') ?? '2027-01-01';
          return sendJson(res, 200, await stockMovementReport(pool, { from, to }));
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
        // Clinical history (EHR-004)
        if (p === '/api/ehr/history' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof addHistoryItem>[1];
          try { return sendJson(res, 201, await addHistoryItem(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'history_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/history/status' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setHistoryStatus>[1];
          try { return sendJson(res, 200, await setHistoryStatus(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'history_status_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/history' && req.method === 'GET') {
          return sendJson(res, 200, { history: await listHistory(pool, url.searchParams.get('patientId') ?? '', url.searchParams.get('category') ?? undefined) });
        }
        // Coded diagnoses (EHR-005)
        if (p === '/api/ehr/diagnosis-codes' && req.method === 'GET') {
          return sendJson(res, 200, { codes: await searchDiagnosisCodes(pool, url.searchParams.get('q') ?? '') });
        }
        if (p === '/api/ehr/diagnosis' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof recordDiagnosis>[1];
          try { return sendJson(res, 201, await recordDiagnosis(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'diagnosis_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/diagnosis' && req.method === 'GET') {
          return sendJson(res, 200, { diagnoses: await listDiagnoses(pool, url.searchParams.get('encounterId') ?? '') });
        }
        // Draft recovery (EHR-007)
        if (p === '/api/ehr/draft/open' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof openDraftEncounter>[1];
          return sendJson(res, 200, await openDraftEncounter(pool, b));
        }
        if (p === '/api/ehr/draft/autosave' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof autosaveDraft>[1];
          try { return sendJson(res, 200, await autosaveDraft(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'autosave_rejected', message: (err as Error).message } }); }
        }
        // Care plans (EHR-006)
        if (p === '/api/ehr/care-plan' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof createCarePlan>[1];
          try { return sendJson(res, 201, await createCarePlan(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'care_plan_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/care-plan/goal' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof addGoal>[1];
          try { return sendJson(res, 201, await addGoal(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'goal_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/care-plan/followup' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof addFollowUp>[1];
          try { return sendJson(res, 201, await addFollowUp(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'followup_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/care-plan/followup/complete' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof completeFollowUp>[1];
          try { return sendJson(res, 200, await completeFollowUp(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'followup_complete_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/care-plans' && req.method === 'GET') {
          return sendJson(res, 200, { carePlans: await listCarePlans(pool, url.searchParams.get('patientId') ?? '') });
        }
        if (p === '/api/ehr/care-plan/overdue' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, { overdue: await overdueFollowUps(pool, asOf) });
        }
        // Clinical document generation (EHR-011)
        if (p === '/api/ehr/document/visit-summary' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof generateVisitSummary>[1];
          try { return sendJson(res, 200, await generateVisitSummary(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'docgen_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/document/prescription' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof generatePrescription>[1];
          try { return sendJson(res, 200, await generatePrescription(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'docgen_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/document/sick-note' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof generateSickNote>[1];
          try { return sendJson(res, 200, await generateSickNote(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'docgen_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/document/referral' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof generateReferral>[1];
          try { return sendJson(res, 200, await generateReferral(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'docgen_rejected', message: (err as Error).message } }); }
        }
        // Clinical handover / internal messages (EHR-012)
        if (p === '/api/ehr/handover' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof sendHandover>[1];
          try { return sendJson(res, 201, await sendHandover(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'handover_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/handover/ack' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof acknowledgeHandover>[1];
          try { return sendJson(res, 200, await acknowledgeHandover(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'handover_ack_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/ehr/inbox' && req.method === 'GET') {
          return sendJson(res, 200, { inbox: await inbox(pool, url.searchParams.get('staffId') ?? '', url.searchParams.get('all') === 'true') });
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
        if (p === '/api/prescribe/template' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof defineRxTemplate>[1];
          try { return sendJson(res, 201, await defineRxTemplate(pool, b)); } catch (err) { return sendJson(res, 400, { error: { code: 'rx_template_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/prescribe/template/apply' && req.method === 'POST') {
          const b = (await readBody(req)) as { templateCode: string };
          try { return sendJson(res, 200, await applyRxTemplate(pool, b)); } catch (err) { return sendJson(res, 404, { error: { code: 'rx_template_apply_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/prescribe/administer' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof recordAdministration>[1];
          try { return sendJson(res, 201, await recordAdministration(pool, { ...b, ...(ctx.user ? { performer: ctx.user } : {}) })); } catch (err) { return sendJson(res, 422, { error: { code: 'administration_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/prescribe/administrations' && req.method === 'GET') {
          return sendJson(res, 200, { administrations: await listAdministrations(pool, { requestId: url.searchParams.get('requestId') ?? '' }) });
        }
        if (p === '/api/formulary' && req.method === 'GET') {
          return sendJson(res, 200, { items: await searchFormulary(pool, url.searchParams.get('q') ?? '', url.searchParams.get('location') ?? undefined) });
        }
        if (p === '/api/dispense/worklist' && req.method === 'GET') {
          return sendJson(res, 200, { worklist: await dispensingWorklist(pool) });
        }
        if (p === '/api/dispense/mark' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof markDispensed>[1];
          try { return sendJson(res, 200, await markDispensed(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'dispense_mark_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/prescription/print' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof generateMedPrescription>[1];
          try { return sendJson(res, 200, await generateMedPrescription(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'prescription_print_rejected', message: (err as Error).message } }); }
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
        if (p === '/api/orders/external-result' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof attachExternalResult>[1];
          try { return sendJson(res, 201, await attachExternalResult(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'external_result_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/orders/external-result/reconcile' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof reconcileExternalResult>[1];
          try { return sendJson(res, 200, await reconcileExternalResult(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'reconcile_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/orders/unmatched' && req.method === 'GET') {
          return sendJson(res, 200, { unmatched: await unmatchedResults(pool) });
        }
        if (p === '/api/orders/cancel' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof cancelOrder>[1];
          try { return sendJson(res, 200, await cancelOrder(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'cancel_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/orders/result/correct' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof correctResult>[1];
          try { return sendJson(res, 200, await correctResult(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'correct_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/orders/set' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof defineOrderSet>[1];
          try { return sendJson(res, 201, await defineOrderSet(pool, b)); } catch (err) { return sendJson(res, 400, { error: { code: 'order_set_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/orders/set/apply' && req.method === 'POST') {
          const b = (await readBody(req)) as { setCode: string; patientId: string; encounterId?: string };
          try { return sendJson(res, 201, await applyOrderSet(pool, { ...b, ...(ctx.user ? { requestedBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 400, { error: { code: 'order_set_apply_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/orders/specimen-label' && req.method === 'POST') {
          const b = (await readBody(req)) as { orderId: string; collectedOn?: string };
          try { return sendJson(res, 201, await generateSpecimenLabel(pool, b)); } catch (err) { return sendJson(res, 404, { error: { code: 'specimen_label_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/referrals' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof createReferral>[1];
          try { return sendJson(res, 201, await createReferral(pool, { ...b, ...(ctx.user ? { sentBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 400, { error: { code: 'referral_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/referrals/status' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof updateReferral>[1];
          try { return sendJson(res, 200, await updateReferral(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'referral_transition_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/referrals/open' && req.method === 'GET') {
          return sendJson(res, 200, { referrals: await listOpenReferrals(pool) });
        }
        if (p === '/api/public/queue' && req.method === 'GET') {
          return sendJson(res, 200, { queue: await publicQueue(pool) }); // VIS-009 de-identified
        }
        if (p === '/api/patients/summary/export' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; purpose: string; recipient?: string; format?: string };
          try { return sendJson(res, 201, await exportPatientSummary(pool, { ...b, ...(ctx.user ? { disclosedBy: ctx.user } : {}) })); }
          catch (err) { if (err instanceof DisclosureError) return sendJson(res, 400, { error: { code: 'disclosure_rejected', message: err.message } }); throw err; }
        }
        if (p === '/api/patients/disclosures' && req.method === 'GET') {
          return sendJson(res, 200, { disclosures: await listPatientDisclosures(pool, { patientId: url.searchParams.get('patientId') ?? '' }) });
        }
        if (p === '/api/patients/card' && req.method === 'GET') {
          try { return sendJson(res, 200, await patientCard(pool, url.searchParams.get('patientId') ?? '')); } catch (err) { return sendJson(res, 404, { error: { code: 'patient_not_found', message: (err as Error).message } }); }
        }
        if (p === '/api/patients/card/resolve' && req.method === 'POST') {
          const b = (await readBody(req)) as { payload: string };
          try { return sendJson(res, 200, await resolveCard(pool, b.payload)); } catch (err) { return sendJson(res, 404, { error: { code: 'card_unresolved', message: (err as Error).message } }); }
        }
        if (p === '/api/visits/check-in' && req.method === 'GET') {
          try { return sendJson(res, 200, await checkInView(pool, url.searchParams.get('visitId') ?? '')); } catch (err) { return sendJson(res, 404, { error: { code: 'visit_not_found', message: (err as Error).message } }); }
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
        if (p === '/api/schedule/reminder' && req.method === 'POST') {
          const b = (await readBody(req)) as { when: string; time?: string; location?: string; reason?: string; sensitive?: boolean };
          // APT-009: a sensitive appointment's reason is never placed in the message.
          return sendJson(res, 200, { message: appointmentReminder({ when: b.when, ...(b.time ? { time: b.time } : {}), ...(b.location ? { location: b.location } : {}), ...(b.reason ? { reason: b.reason } : {}), sensitive: b.sensitive === true }) });
        }
        if (p === '/api/schedule/waitlist' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof addToWaitlist>[1];
          return sendJson(res, 201, await addToWaitlist(pool, { ...b, ...(ctx.user ? { user: ctx.user } : {}) }));
        }
        if (p === '/api/schedule/fill' && req.method === 'POST') {
          const b = (await readBody(req)) as { slotId: string };
          const out = await fillReleasedSlot(pool, { slotId: b.slotId, ...(ctx.user ? { user: ctx.user } : {}) });
          return sendJson(res, out.filled ? 201 : 200, out);
        }
        if (p === '/api/schedule/reminder-queue' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof queueReminder>[1];
          const out = await queueReminder(pool, b);
          return sendJson(res, out.enqueued ? 201 : 200, out);
        }
        if (p === '/api/schedule/type' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setAppointmentType>[1];
          try { return sendJson(res, 201, await setAppointmentType(pool, { ...b, ...(ctx.user ? { by: ctx.user } : {}) })); }
          catch (err) { return sendJson(res, 409, { error: { code: 'appointment_type_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/schedule/type' && req.method === 'GET') {
          const code = url.searchParams.get('code') ?? '';
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          const t = await resolveAppointmentType(pool, { code, asOf });
          if (!t) return sendJson(res, 404, { error: { code: 'appointment_type_not_found' } });
          return sendJson(res, 200, t);
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
        if (p === '/api/visits/escalate' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof escalateVisit>[1];
          try { return sendJson(res, 200, await escalateVisit(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'escalate_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/visits/hold' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof holdVisit>[1];
          try { return sendJson(res, 200, await holdVisit(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'hold_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/visits/resume' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof resumeVisit>[1];
          try { return sendJson(res, 200, await resumeVisit(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'resume_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/visits/outcome' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof endVisitWithOutcome>[1];
          try { return sendJson(res, 200, await endVisitWithOutcome(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'outcome_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/visits/durations' && req.method === 'GET') {
          try { return sendJson(res, 200, await visitDurations(pool, url.searchParams.get('visitId') ?? '')); } catch (err) { return sendJson(res, 404, { error: { code: 'visit_not_found', message: (err as Error).message } }); }
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
        if (p === '/api/ops/productivity' && req.method === 'GET') {
          const from = url.searchParams.get('from') ?? '2026-01-01';
          const to = url.searchParams.get('to') ?? '2027-01-01';
          return sendJson(res, 200, { productivity: await staffProductivity(pool, { from, to }) });
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
        if (p === '/api/documents/index' && req.method === 'POST') {
          const b = (await readBody(req)) as { documentId: string; terms?: string[]; ocrText?: string };
          try { return sendJson(res, 201, await indexDocument(pool, { ...b, ...(ctx.user ? { indexedBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 404, { error: { code: 'index_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/documents/search' && req.method === 'GET') {
          return sendJson(res, 200, { documents: await searchDocuments(pool, url.searchParams.get('term') ?? '') });
        }
        if (p === '/api/billing/receipt/print' && req.method === 'POST') {
          const b = (await readBody(req)) as { paymentId: string; date?: string };
          try { return sendJson(res, 200, await printReceipt(pool, { ...b, ...(ctx.user ? { printedBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 404, { error: { code: 'receipt_print_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/invoice/print' && req.method === 'POST') {
          const b = (await readBody(req)) as { invoiceId: string; date?: string };
          try { return sendJson(res, 200, await printInvoice(pool, { ...b, ...(ctx.user ? { printedBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 404, { error: { code: 'invoice_print_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/billing/statement/print' && req.method === 'POST') {
          const b = (await readBody(req)) as { patientId: string; date?: string };
          try { return sendJson(res, 200, await printStatement(pool, { ...b, ...(ctx.user ? { printedBy: ctx.user } : {}) })); } catch (err) { return sendJson(res, 404, { error: { code: 'statement_print_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/documents/generate' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof storeGeneratedDocument>[1];
          return sendJson(res, 201, await storeGeneratedDocument(pool, b));
        }
        if (p === '/api/documents/supersede' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof supersedeDocument>[1];
          try { return sendJson(res, 200, await supersedeDocument(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'supersede_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/documents/entered-in-error' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof markDocumentEnteredInError>[1];
          try { return sendJson(res, 200, await markDocumentEnteredInError(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'eie_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/documents/legal-hold' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setLegalHold>[1];
          try { return sendJson(res, 200, await setLegalHold(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'legal_hold_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/documents/retention' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setRetention>[1];
          try { return sendJson(res, 200, await setRetention(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'retention_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/documents/disposal-candidates' && req.method === 'GET') {
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return sendJson(res, 200, { candidates: await disposalCandidates(pool, asOf) });
        }
        if (p === '/api/documents/dispose' && req.method === 'POST') {
          const b = (await readBody(req)) as { documentId: string; asOf?: string; by: string };
          try { return sendJson(res, 200, await disposeDocument(pool, { documentId: b.documentId, asOf: b.asOf ?? new Date().toISOString().slice(0, 10), by: b.by })); } catch (err) { return sendJson(res, 409, { error: { code: 'dispose_rejected', message: (err as Error).message } }); }
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
        if (p === '/api/finance/ledger-export' && req.method === 'GET') {
          const periodId = url.searchParams.get('periodId') ?? '';
          try { return sendJson(res, 200, await exportApprovedLedger(pool, { periodId, ...(ctx.user ? { exportedBy: ctx.user } : {}) })); }
          catch (err) { return sendJson(res, 422, { error: { code: 'ledger_export_failed', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/break-even' && req.method === 'POST') {
          const b = (await readBody(req)) as { fixedCostMinor: number; unitPriceMinor: number; unitVariableCostMinor: number; investmentMinor?: number; fundingMinor?: number; monthlyNetMinor?: number };
          try {
            const be = breakEven({ fixedCostMinor: b.fixedCostMinor, unitPriceMinor: b.unitPriceMinor, unitVariableCostMinor: b.unitVariableCostMinor });
            const recovery = b.investmentMinor !== undefined
              ? investmentRecovery({ investmentMinor: b.investmentMinor, fundingMinor: b.fundingMinor ?? 0, monthlyNetMinor: b.monthlyNetMinor ?? 0 })
              : null;
            return sendJson(res, 200, { breakEven: be, recovery });
          } catch (err) { return sendJson(res, 422, { error: { code: 'break_even_unreachable', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/balance-sheet' && req.method === 'GET') {
          return sendJson(res, 200, await balanceSheet(pool));
        }
        if (p === '/api/finance/budget' && req.method === 'POST') {
          const b = (await readBody(req)) as Parameters<typeof setBudget>[1];
          try { return sendJson(res, 201, await setBudget(pool, b)); } catch (err) { return sendJson(res, 409, { error: { code: 'budget_rejected', message: (err as Error).message } }); }
        }
        if (p === '/api/finance/budget-variance' && req.method === 'GET') {
          return sendJson(res, 200, await budgetVariance(pool, { periodId: url.searchParams.get('periodId') ?? '' }));
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
