/**
 * The /api router for the Worker. Deny-by-default RBAC (reusing the domain
 * `can()`), then dispatch to a D1-backed handler (auth → handler → D1). This set
 * covers the full PWA surface — the five screens a user clicks through
 * (Dispense, Patients, Queue, Calendar, Command centre) — on Cloudflare/D1.
 */
import { can, type Permission, StockError, VitalError, breakEven, investmentRecovery, appointmentReminder } from '@sancta/domain';
import {
  skuOnHand, commitCheckoutD1, DuplicateCheckoutError,
  receiveGoods, stockAlerts, InventoryError,
  listPatients, registerPatient, startVisit, queueBoard, createSlot, calendarView, dashboard,
  transfer, completeVisit, VisitError,
  bookAppointment, nextAvailableSlot, setAppointmentStatus, addToWaitlist, fillReleasedSlot, queueReminder, setAppointmentType, resolveAppointmentType, SchedulingError,
  createOrder, setOrderStatus, releaseResult, acknowledgeCritical, outstandingCriticalResults,
  attachExternalResult, reconcileExternalResult, unmatchedResults, cancelOrder, correctResult,
  defineOrderSet, applyOrderSet, generateSpecimenLabel, createReferral, updateReferral, listOpenReferrals, OrderError,
  createDraftEncounter, updateDraft, signEncounter, addAddendum, markEnteredInError, getEncounter, EncounterError,
  recordVitals, recordTriageAssessment, recordIntervention, signTriage, openTriageQueue, triageSummary, TriageError,
  recordAllergy, prescribe, defineRxTemplate, applyRxTemplate, recordAdministration, listAdministrations, PrescribingError,
  searchFormulary, dispensingWorklist, markDispensed, generatePrescription, MedicationError,
  createCarePlan, addGoal, addFollowUp, completeFollowUp, listCarePlans, overdueFollowUps, CarePlanError,
  recordPayment, allocate, reallocate, refundPayment, invoiceOutstanding, BillingError,
  closePeriod, reopenPeriod, periodStatus, FinanceError, PeriodClosedError,
  trialBalance, incomeStatement, exportApprovedLedger, capitaliseAsset, assetRegister, disposeAsset, marginReport, FixedAssetError,
  draftManualJournal, approveManualJournal, rejectManualJournal, listManualJournals, ManualJournalError,
  createCostCentre, listCostCentres, defineAccount, reviseAccount, accountAsOf, chartOfAccounts, createDimension, addDimensionValue, listDimensions, ChartAdminError,
  recordExpense, paySupplier, apReconciliation, PayableError,
  setBudget, budgetVariance, BudgetError,
  balanceSheet, monthlyClose,
  openShift, closeCashierShift, ShiftError, CashierError,
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
    if (p === '/api/stock/receive' && method === 'POST') {
      const denied = guard('create'); if (denied) return denied;
      try { return json(await receiveGoods(env.DB, { ...(await request.json()) as Parameters<typeof receiveGoods>[1], ...(auth.user ? { user: auth.user } : {}) }), 201); }
      catch (e) { if (e instanceof InventoryError) return json({ error: { code: 'receipt_rejected', message: e.message } }, 400); throw e; }
    }
    if (p === '/api/stock/alerts' && method === 'GET') {
      const denied = guard('view_summary'); if (denied) return denied;
      const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
      return json({ alerts: await stockAlerts(env.DB, asOf) });
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
        if (e instanceof PeriodClosedError) return json({ ok: false, error: { code: 'period_closed', message: e.message } }, 409);
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
    if (p === '/api/visits/transfer' && method === 'POST') {
      const denied = guard('amend'); if (denied) return denied;
      try { await transfer(env.DB, (await request.json()) as Parameters<typeof transfer>[1]); return json({ ok: true }); }
      catch (e) { if (e instanceof VisitError) return json({ error: { code: 'no_queue_entry', message: e.message } }, 404); throw e; }
    }
    if (p === '/api/visits/complete' && method === 'POST') {
      const denied = guard('amend'); if (denied) return denied;
      const b = (await request.json()) as { visitId: string; override?: boolean; reason?: string };
      const out = await completeVisit(env.DB, { ...b, ...(auth.user ? { user: auth.user } : {}) });
      return json(out, out.ok ? 200 : 409);
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
    // --- Appointment lifecycle: book / status / waitlist / reminders / types (APT-001..008) --
    if (p.startsWith('/api/schedule/')) {
      try {
        if (p === '/api/schedule/book' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const out = await bookAppointment(env.DB, (await request.json()) as Parameters<typeof bookAppointment>[1]);
          return json(out, out.ok ? 201 : 409);
        }
        if (p === '/api/schedule/next' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json({ slot: await nextAvailableSlot(env.DB, { provider: url.searchParams.get('provider') ?? '', afterIso: url.searchParams.get('after') ?? new Date().toISOString() }) });
        }
        if (p === '/api/schedule/status' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          return json(await setAppointmentStatus(env.DB, (await request.json()) as Parameters<typeof setAppointmentStatus>[1]));
        }
        if (p === '/api/schedule/reminder' && method === 'POST') {
          const denied = guard('view_summary'); if (denied) return denied;
          const b = (await request.json()) as { when: string; time?: string; location?: string; reason?: string; sensitive?: boolean };
          return json({ message: appointmentReminder({ when: b.when, ...(b.time ? { time: b.time } : {}), ...(b.location ? { location: b.location } : {}), ...(b.reason ? { reason: b.reason } : {}), sensitive: b.sensitive === true }) });
        }
        if (p === '/api/schedule/waitlist' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const b = (await request.json()) as Parameters<typeof addToWaitlist>[1];
          return json(await addToWaitlist(env.DB, { ...b, ...(auth.user ? { user: auth.user } : {}) }), 201);
        }
        if (p === '/api/schedule/fill' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const b = (await request.json()) as { slotId: string };
          const out = await fillReleasedSlot(env.DB, { slotId: b.slotId, ...(auth.user ? { user: auth.user } : {}) });
          return json(out, out.filled ? 201 : 200);
        }
        if (p === '/api/schedule/reminder-queue' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const out = await queueReminder(env.DB, (await request.json()) as Parameters<typeof queueReminder>[1]);
          return json(out, out.enqueued ? 201 : 200);
        }
        if (p === '/api/schedule/type' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          const b = (await request.json()) as Parameters<typeof setAppointmentType>[1];
          return json(await setAppointmentType(env.DB, { ...b, ...(auth.user ? { by: auth.user } : {}) }), 201);
        }
        if (p === '/api/schedule/type' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          const t = await resolveAppointmentType(env.DB, { code: url.searchParams.get('code') ?? '', asOf: url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10) });
          return json(t ?? { error: { code: 'not_found' } }, t ? 200 : 404);
        }
      } catch (e) {
        if (e instanceof SchedulingError) return json({ error: { code: 'schedule_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Command centre ----------------------------------------------------
    if (p === '/api/management/dashboard' && method === 'GET') {
      const denied = guard('view_summary');
      if (denied) return denied;
      return json(await dashboard(env.DB, new Date().toISOString()));
    }

    // --- Month-end close & balance sheet (FIN-004/010) --------------------
    if (p === '/api/finance/balance-sheet' || p === '/api/finance/monthly-close') {
      try {
        if (p === '/api/finance/balance-sheet' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json(await balanceSheet(env.DB));
        }
        if (p === '/api/finance/monthly-close' && method === 'POST') {
          const denied = guard('approve'); if (denied) return denied;
          return json(await monthlyClose(env.DB, (await request.json()) as Parameters<typeof monthlyClose>[1]));
        }
      } catch (e) {
        if (e instanceof PeriodClosedError) return json({ error: { code: 'period_closed', message: e.message } }, 409);
        if (e instanceof FinanceError) return json({ error: { code: 'monthly_close_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Budgets, variance & break-even (FIN-007) -------------------------
    if (p === '/api/finance/budget' || p === '/api/finance/budget-variance' || p === '/api/finance/break-even') {
      try {
        if (p === '/api/finance/budget' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          return json(await setBudget(env.DB, (await request.json()) as Parameters<typeof setBudget>[1]), 201);
        }
        if (p === '/api/finance/budget-variance' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json(await budgetVariance(env.DB, { periodId: url.searchParams.get('periodId') ?? '' }));
        }
        if (p === '/api/finance/break-even' && method === 'POST') {
          const denied = guard('view_summary'); if (denied) return denied;
          const b = (await request.json()) as { fixedCostMinor: number; unitPriceMinor: number; unitVariableCostMinor: number; investmentMinor?: number; fundingMinor?: number; monthlyNetMinor?: number };
          try {
            const be = breakEven({ fixedCostMinor: b.fixedCostMinor, unitPriceMinor: b.unitPriceMinor, unitVariableCostMinor: b.unitVariableCostMinor });
            const recovery = b.investmentMinor !== undefined ? investmentRecovery({ investmentMinor: b.investmentMinor, fundingMinor: b.fundingMinor ?? 0, monthlyNetMinor: b.monthlyNetMinor ?? 0 }) : null;
            return json({ breakEven: be, recovery });
          } catch (e) { return json({ error: { code: 'break_even_unreachable', message: String((e as Error).message) } }, 422); }
        }
      } catch (e) {
        if (e instanceof BudgetError) return json({ error: { code: 'budget_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Payables: expenses, supplier payment, AP reconciliation (FIN-005/006) --
    if (p === '/api/finance/expense' || p === '/api/finance/pay-supplier' || p === '/api/finance/ap-reconciliation') {
      try {
        if (p === '/api/finance/expense' && method === 'POST') {
          const denied = guard('approve'); if (denied) return denied;
          return json(await recordExpense(env.DB, (await request.json()) as Parameters<typeof recordExpense>[1]), 201);
        }
        if (p === '/api/finance/pay-supplier' && method === 'POST') {
          const denied = guard('approve'); if (denied) return denied;
          return json(await paySupplier(env.DB, (await request.json()) as Parameters<typeof paySupplier>[1]));
        }
        if (p === '/api/finance/ap-reconciliation' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json(await apReconciliation(env.DB));
        }
      } catch (e) {
        if (e instanceof PeriodClosedError) return json({ error: { code: 'period_closed', message: e.message } }, 409);
        if (e instanceof PayableError) return json({ error: { code: 'payable_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Chart of accounts / cost centres / dimensions (FIN-001) ----------
    if (p === '/api/finance/chart' || p.startsWith('/api/finance/account') || p.startsWith('/api/finance/cost-centre') || p.startsWith('/api/finance/dimension')) {
      try {
        if (p === '/api/finance/chart' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return json({ asOf, accounts: await chartOfAccounts(env.DB, asOf) });
        }
        if (p === '/api/finance/account' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          try { return json(await accountAsOf(env.DB, url.searchParams.get('code') ?? '', asOf)); }
          catch (e) { return json({ error: { code: 'account_not_found', message: String((e as Error).message) } }, 404); }
        }
        if (p === '/api/finance/account' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          return json(await defineAccount(env.DB, (await request.json()) as Parameters<typeof defineAccount>[1]), 201);
        }
        if (p === '/api/finance/account/revise' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          return json(await reviseAccount(env.DB, (await request.json()) as Parameters<typeof reviseAccount>[1]));
        }
        if (p === '/api/finance/cost-centres' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json({ costCentres: await listCostCentres(env.DB) });
        }
        if (p === '/api/finance/cost-centre' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          return json(await createCostCentre(env.DB, (await request.json()) as Parameters<typeof createCostCentre>[1]), 201);
        }
        if (p === '/api/finance/dimensions' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json({ dimensions: await listDimensions(env.DB) });
        }
        if (p === '/api/finance/dimension' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          return json(await createDimension(env.DB, (await request.json()) as Parameters<typeof createDimension>[1]), 201);
        }
        if (p === '/api/finance/dimension/value' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          return json(await addDimensionValue(env.DB, (await request.json()) as Parameters<typeof addDimensionValue>[1]), 201);
        }
      } catch (e) {
        if (e instanceof ChartAdminError) return json({ error: { code: 'chart_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Manual journal: maker-checker (FIN-003, BR-011) ------------------
    if (p.startsWith('/api/finance/journal')) {
      try {
        if (p === '/api/finance/journal' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json({ journals: await listManualJournals(env.DB, url.searchParams.get('status') ?? undefined) });
        }
        if (p === '/api/finance/journal/draft' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await draftManualJournal(env.DB, (await request.json()) as Parameters<typeof draftManualJournal>[1]), 201);
        }
        if (p === '/api/finance/journal/post' && method === 'POST') {
          const denied = guard('approve'); if (denied) return denied;
          return json(await approveManualJournal(env.DB, (await request.json()) as Parameters<typeof approveManualJournal>[1]));
        }
        if (p === '/api/finance/journal/reject' && method === 'POST') {
          const denied = guard('approve'); if (denied) return denied;
          return json(await rejectManualJournal(env.DB, (await request.json()) as Parameters<typeof rejectManualJournal>[1]));
        }
      } catch (e) {
        if (e instanceof PeriodClosedError) return json({ error: { code: 'period_closed', message: e.message } }, 409);
        if (e instanceof ManualJournalError) return json({ error: { code: 'journal_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Finance reports: statements, ledger export, assets, margin (FIN-008/010/011/014) --
    if (p.startsWith('/api/finance/trial-balance') || p.startsWith('/api/finance/income-statement') || p.startsWith('/api/finance/ledger-export') || p.startsWith('/api/finance/asset') || p.startsWith('/api/finance/margin')) {
      try {
        if (p === '/api/finance/trial-balance' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json(await trialBalance(env.DB));
        }
        if (p === '/api/finance/income-statement' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json(await incomeStatement(env.DB));
        }
        if (p === '/api/finance/ledger-export' && method === 'GET') {
          const denied = guard('export'); if (denied) return denied;
          try {
            return json(await exportApprovedLedger(env.DB, { periodId: url.searchParams.get('periodId') ?? '', ...(auth.user ? { exportedBy: auth.user } : {}) }));
          } catch (e) { return json({ error: { code: 'ledger_export_failed', message: String((e as Error).message) } }, 422); }
        }
        if (p === '/api/finance/asset' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          const b = (await request.json()) as Parameters<typeof capitaliseAsset>[1];
          return json(await capitaliseAsset(env.DB, { ...b, ...(auth.user ? { createdBy: auth.user } : {}) }), 201);
        }
        if (p === '/api/finance/asset/register' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return json({ assets: await assetRegister(env.DB, { asOf }) });
        }
        if (p === '/api/finance/asset/dispose' && method === 'POST') {
          const denied = guard('configure'); if (denied) return denied;
          const b = (await request.json()) as { assetId: string; disposedOn: string; proceedsMinor: number };
          return json(await disposeAsset(env.DB, { ...b, ...(auth.user ? { by: auth.user } : {}) }));
        }
        if (p === '/api/finance/margin' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json(await marginReport(env.DB));
        }
      } catch (e) {
        if (e instanceof FixedAssetError) return json({ error: { code: 'asset_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Cashier shift open/close (BIL-009, UAT-09) -----------------------
    if (p === '/api/cashier/open' || p === '/api/cashier/close') {
      try {
        if (p === '/api/cashier/open' && method === 'POST') {
          const denied = guard('receive_payment'); if (denied) return denied;
          return json(await openShift(env.DB, (await request.json()) as Parameters<typeof openShift>[1]), 201);
        }
        if (p === '/api/cashier/close' && method === 'POST') {
          const denied = guard('receive_payment'); if (denied) return denied;
          return json(await closeCashierShift(env.DB, (await request.json()) as Parameters<typeof closeCashierShift>[1]));
        }
      } catch (e) {
        if (e instanceof CashierError) return json({ error: { code: 'shift_approval_required', message: e.message } }, 409);
        if (e instanceof ShiftError) return json({ error: { code: 'shift_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Finance: period control (FIN-009, BR-010, UAT-13) ----------------
    if (p.startsWith('/api/finance/period')) {
      try {
        if (p === '/api/finance/period/close' && method === 'POST') {
          const denied = guard('approve'); if (denied) return denied;
          return json(await closePeriod(env.DB, (await request.json()) as Parameters<typeof closePeriod>[1]));
        }
        if (p === '/api/finance/period/reopen' && method === 'POST') {
          const denied = guard('approve'); if (denied) return denied;
          return json(await reopenPeriod(env.DB, (await request.json()) as Parameters<typeof reopenPeriod>[1]));
        }
        if (p === '/api/finance/period' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          const id = url.searchParams.get('id') ?? '';
          return json({ periodId: id, status: await periodStatus(env.DB, id) });
        }
      } catch (e) {
        if (e instanceof FinanceError) return json({ error: { code: 'finance_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Billing: payments, allocation, reallocation, refunds (BIL-006/010) --
    if (p.startsWith('/api/billing/')) {
      try {
        if (p === '/api/billing/payment' && method === 'POST') {
          const denied = guard('receive_payment'); if (denied) return denied;
          return json(await recordPayment(env.DB, (await request.json()) as Parameters<typeof recordPayment>[1]), 201);
        }
        if (p === '/api/billing/allocate' && method === 'POST') {
          const denied = guard('receive_payment'); if (denied) return denied;
          await allocate(env.DB, (await request.json()) as Parameters<typeof allocate>[1]);
          return json({ ok: true });
        }
        if (p === '/api/billing/reallocate' && method === 'POST') {
          const denied = guard('reverse'); if (denied) return denied;
          await reallocate(env.DB, (await request.json()) as Parameters<typeof reallocate>[1]);
          return json({ ok: true });
        }
        if (p === '/api/billing/refund' && method === 'POST') {
          const denied = guard('reverse'); if (denied) return denied;
          return json(await refundPayment(env.DB, (await request.json()) as Parameters<typeof refundPayment>[1]), 201);
        }
        if (p === '/api/billing/invoice-outstanding' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          const id = url.searchParams.get('id') ?? '';
          return json({ invoiceId: id, outstandingMinor: await invoiceOutstanding(env.DB, id) });
        }
      } catch (e) {
        if (e instanceof PeriodClosedError) return json({ error: { code: 'period_closed', message: e.message } }, 409);
        if (e instanceof BillingError) return json({ error: { code: 'billing_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Care plans, goals & follow-ups (EHR-006) -------------------------
    if (p.startsWith('/api/ehr/care-plan')) {
      try {
        if (p === '/api/ehr/care-plan' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          const b = (await request.json()) as Parameters<typeof createCarePlan>[1];
          return json(await createCarePlan(env.DB, { ...b, ...(auth.user ? { user: auth.user } : {}) }), 201);
        }
        if (p === '/api/ehr/care-plan/goal' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await addGoal(env.DB, (await request.json()) as Parameters<typeof addGoal>[1]), 201);
        }
        if (p === '/api/ehr/care-plan/followup' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await addFollowUp(env.DB, (await request.json()) as Parameters<typeof addFollowUp>[1]), 201);
        }
        if (p === '/api/ehr/care-plan/followup/complete' && method === 'POST') {
          const denied = guard('amend'); if (denied) return denied;
          const b = (await request.json()) as { id: string };
          return json(await completeFollowUp(env.DB, { ...b, ...(auth.user ? { user: auth.user } : {}) }));
        }
        if (p === '/api/ehr/care-plans' && method === 'GET') {
          const denied = guard('view_clinical_detail'); if (denied) return denied;
          return json({ carePlans: await listCarePlans(env.DB, url.searchParams.get('patientId') ?? '') });
        }
        if (p === '/api/ehr/care-plan/overdue' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
          return json({ overdue: await overdueFollowUps(env.DB, asOf) });
        }
      } catch (e) {
        if (e instanceof CarePlanError) return json({ error: { code: 'care_plan_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Formulary / dispensing / prescription print (MED-001/005/006) ----
    if (p === '/api/formulary' || p.startsWith('/api/dispense/') || p === '/api/prescription/print') {
      try {
        if (p === '/api/formulary' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json({ items: await searchFormulary(env.DB, url.searchParams.get('q') ?? '', url.searchParams.get('location') ?? undefined) });
        }
        if (p === '/api/dispense/worklist' && method === 'GET') {
          const denied = guard('dispense'); if (denied) return denied;
          return json({ worklist: await dispensingWorklist(env.DB) });
        }
        if (p === '/api/dispense/mark' && method === 'POST') {
          const denied = guard('dispense'); if (denied) return denied;
          const b = (await request.json()) as { requestId: string };
          return json(await markDispensed(env.DB, { ...b, ...(auth.user ? { dispensedBy: auth.user } : {}) }));
        }
        if (p === '/api/prescription/print' && method === 'POST') {
          const denied = guard('view_clinical_detail'); if (denied) return denied;
          return json(await generatePrescription(env.DB, (await request.json()) as Parameters<typeof generatePrescription>[1]));
        }
      } catch (e) {
        if (e instanceof MedicationError) return json({ error: { code: 'medication_rejected', message: e.message } }, 409);
        throw e;
      }
    }

    // --- Prescribing + allergy override (MED-002/003/004/009, UAT-05) -----
    if (p === '/api/allergies' && method === 'POST') {
      const denied = guard('create'); if (denied) return denied;
      return json(await recordAllergy(env.DB, (await request.json()) as Parameters<typeof recordAllergy>[1]), 201);
    }
    if (p.startsWith('/api/prescribe')) {
      try {
        if (p === '/api/prescribe' && method === 'POST') {
          const denied = guard('sign'); if (denied) return denied;
          const result = await prescribe(env.DB, (await request.json()) as Parameters<typeof prescribe>[1]);
          return json(result, result.ok ? 201 : 409); // allergy alert (no override) → 409
        }
        if (p === '/api/prescribe/template' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await defineRxTemplate(env.DB, (await request.json()) as Parameters<typeof defineRxTemplate>[1]), 201);
        }
        if (p === '/api/prescribe/template/apply' && method === 'POST') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json(await applyRxTemplate(env.DB, (await request.json()) as Parameters<typeof applyRxTemplate>[1]));
        }
        if (p === '/api/prescribe/administer' && method === 'POST') {
          const denied = guard('dispense'); if (denied) return denied;
          return json(await recordAdministration(env.DB, (await request.json()) as Parameters<typeof recordAdministration>[1]), 201);
        }
        if (p === '/api/prescribe/administrations' && method === 'GET') {
          const denied = guard('view_clinical_detail'); if (denied) return denied;
          return json({ administrations: await listAdministrations(env.DB, { requestId: url.searchParams.get('requestId') ?? '' }) });
        }
      } catch (e) {
        if (e instanceof PrescribingError) return json({ error: { code: 'prescribing_rejected', message: e.message } }, 422);
        throw e;
      }
    }

    // --- Triage / vitals (TRI-001..008, UAT-03) ---------------------------
    if (p.startsWith('/api/triage')) {
      try {
        if (p === '/api/triage/vitals' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await recordVitals(env.DB, (await request.json()) as Parameters<typeof recordVitals>[1]), 201);
        }
        if (p === '/api/triage/assessment' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await recordTriageAssessment(env.DB, (await request.json()) as Parameters<typeof recordTriageAssessment>[1]), 201);
        }
        if (p === '/api/triage/intervention' && method === 'POST') {
          const denied = guard('create'); if (denied) return denied;
          return json(await recordIntervention(env.DB, (await request.json()) as Parameters<typeof recordIntervention>[1]), 201);
        }
        if (p === '/api/triage/sign' && method === 'POST') {
          const denied = guard('sign'); if (denied) return denied;
          return json(await signTriage(env.DB, (await request.json()) as Parameters<typeof signTriage>[1]));
        }
        if (p === '/api/triage/queue' && method === 'GET') {
          const denied = guard('view_summary'); if (denied) return denied;
          return json({ queue: await openTriageQueue(env.DB) });
        }
        if (p === '/api/triage/summary' && method === 'GET') {
          const denied = guard('view_clinical_detail'); if (denied) return denied;
          return json(await triageSummary(env.DB, url.searchParams.get('encounterId') ?? ''));
        }
      } catch (e) {
        if (e instanceof VitalError) return json({ error: { code: 'vitals_need_confirmation', message: e.message } }, 422);
        if (e instanceof TriageError) return json({ error: { code: 'triage_rejected', message: e.message } }, 422);
        throw e;
      }
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
