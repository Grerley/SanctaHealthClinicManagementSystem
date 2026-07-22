/**
 * Management command centre on D1 (MGT-001/003/008): exceptions first, then KPIs,
 * every figure derived live from the ledgers/records — nothing stored/editable.
 * Ported from the Postgres edge `management.ts`. Now that debtor ageing, critical
 * results and charge-capture are ported, the full KPI/exception set is computed.
 * In the single-Worker/D1 model writes commit directly, so there is no outbox
 * backlog or sync-conflict store — those signals are 0.
 */
import type { D1Database } from './d1.ts';
import { one } from './query.ts';
import { ageingReport } from './debtors.ts';
import { stockAlerts } from './inventory.ts';
import { outstandingCriticalResults } from './orders.ts';
import { chargeCaptureReport } from './billing-completeness.ts';

export type Kpi = { id: string; label: string; value: number; unit: string; owner: string; formula: string };
export type Exception = { type: string; label: string; count: number; queue: string; owner: string };
export type Dashboard = { asOf: string; kpis: Kpi[]; exceptions: Exception[] };

async function scalar(db: D1Database, sql: string, params: unknown[] = []): Promise<number> {
  const r = await one<{ n: number }>(db, sql, params);
  return Number(r?.n ?? 0);
}

export async function dashboard(db: D1Database, asOf: string): Promise<Dashboard> {
  const [ageing, alerts, critical, charge] = await Promise.all([
    ageingReport(db, asOf),
    stockAlerts(db, asOf),
    outstandingCriticalResults(db),
    chargeCaptureReport(db),
  ]);

  const visits = await scalar(db, `SELECT count(*) AS n FROM flow_visit`);
  const completedVisits = await scalar(db, `SELECT count(*) AS n FROM flow_visit WHERE status='complete'`);
  const patients = await scalar(db, `SELECT count(*) AS n FROM identity_patient WHERE deceased = 0`);
  const recognisedRevenueMinor = await scalar(
    db,
    `SELECT COALESCE(SUM(credit_minor)-SUM(debit_minor),0) AS n FROM finance_journal_line WHERE account_code IN ('4000-SERVICE-REVENUE','4010-MEDICINE-REVENUE')`,
  );
  const invoicedEncounters = await scalar(db, `SELECT count(*) AS n FROM billing_invoice WHERE status IN ('finalised','part_paid','paid')`);
  const stockouts = alerts.filter((a) => a.flags.includes('stockout')).length;

  const kpis: Kpi[] = [
    { id: 'visits', label: 'Patient visits', value: visits, unit: 'count', owner: 'Clinic manager', formula: 'count(visits)' },
    { id: 'completed_visits', label: 'Completed visits', value: completedVisits, unit: 'count', owner: 'Clinic manager', formula: "count(visits with status='complete')" },
    { id: 'registered_patients', label: 'Registered patients', value: patients, unit: 'count', owner: 'Clinic manager', formula: 'count(living patients)' },
    { id: 'recognised_revenue', label: 'Recognised revenue', value: recognisedRevenueMinor, unit: 'USD minor', owner: 'Finance officer', formula: 'sum(revenue account credits - debits)' },
    { id: 'outstanding_debtors', label: 'Outstanding debtors', value: ageing.totalMinor, unit: 'USD minor', owner: 'Finance officer', formula: 'sum(open invoice lines - allocations), reconciled to AR control' },
    { id: 'ar_reconciles', label: 'Debtors reconcile to ledger', value: ageing.reconciles ? 1 : 0, unit: 'boolean', owner: 'Finance officer', formula: 'ageing total == AR control account' },
    { id: 'invoiced_encounters', label: 'Finalised invoices', value: invoicedEncounters, unit: 'count', owner: 'Finance officer', formula: 'count(invoices finalised/part-paid/paid)' },
    { id: 'charge_capture_completeness', label: 'Charge-capture completeness', value: charge.completenessPct, unit: '%', owner: 'Finance officer', formula: '(charged + authorised exceptions) / billable completed encounters' },
    { id: 'stockouts', label: 'SKUs at zero stock', value: stockouts, unit: 'count', owner: 'Stock controller', formula: 'count(SKUs with on-hand <= 0)' },
    { id: 'open_critical_results', label: 'Unacknowledged critical results', value: critical.length, unit: 'count', owner: 'Clinical lead', formula: 'count(critical results without acknowledgement)' },
    { id: 'pending_sync', label: 'Pending sync items', value: 0, unit: 'count', owner: 'System administrator', formula: 'cloud-native — writes commit directly (no outbox)' },
  ];

  // Exceptions first — each links to an actionable queue (MGT-003).
  const exceptions: Exception[] = [];
  if (charge.gaps.length > 0) exceptions.push({ type: 'unbilled_encounters', label: 'Billable completed encounters with no charge outcome', count: charge.gaps.length, queue: '/api/charge-capture/report', owner: 'Finance officer' });
  if (critical.length > 0) exceptions.push({ type: 'open_critical_results', label: 'Unacknowledged critical results', count: critical.length, queue: '/api/orders/critical/outstanding', owner: 'Clinical lead' });
  if (alerts.length > 0) exceptions.push({ type: 'stock_alerts', label: 'Stock alerts (stockout/low/expiry)', count: alerts.length, queue: '/api/stock/alerts', owner: 'Stock controller' });
  if (ageing.workQueue.length > 0) exceptions.push({ type: 'debtors', label: 'Patients with outstanding balances', count: ageing.workQueue.length, queue: '/api/debtors/ageing', owner: 'Finance officer' });
  if (!ageing.reconciles) exceptions.push({ type: 'ar_mismatch', label: 'Debtors do not reconcile to the ledger', count: 1, queue: '/api/debtors/ageing', owner: 'Finance officer' });

  return { asOf, kpis, exceptions };
}
