/**
 * Management command centre (MGT-001/003/008). Computes role dashboards from live
 * edge data and leads with EXCEPTIONS before summaries (pack §9). Every KPI
 * carries a definition, owner, unit and formula (MGT-008); every exception links
 * to a work queue (MGT-003). All figures derive from the ledgers and movement
 * records — nothing is a stored/editable total.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';
import { ageingReport } from './debtors.ts';
import { stockAlerts } from './inventory.ts';
import { outstandingCriticalResults } from './orders.ts';
import { PgOutboxStore } from './outbox-store.ts';

export type Kpi = { id: string; label: string; value: number; unit: string; owner: string; formula: string };
export type Exception = { type: string; label: string; count: number; queue: string; owner: string };
export type Dashboard = { asOf: string; kpis: Kpi[]; exceptions: Exception[] };

async function scalar(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

export async function dashboard(pool: Pool, asOf: string): Promise<Dashboard> {
  const [ageing, alerts, critical, pendingSync] = await Promise.all([
    ageingReport(pool, asOf),
    stockAlerts(pool, asOf),
    outstandingCriticalResults(pool),
    new PgOutboxStore(pool).pendingCount(),
  ]);

  const visits = await scalar(pool, `SELECT count(*)::int AS n FROM flow.visit`);
  const completedVisits = await scalar(pool, `SELECT count(*)::int AS n FROM flow.visit WHERE status='complete'`);
  const recognisedRevenueMinor = await scalar(
    pool,
    `SELECT coalesce(sum(credit_minor)-sum(debit_minor),0)::bigint AS n FROM finance.journal_line WHERE account_code IN ('4000-SERVICE-REVENUE','4010-MEDICINE-REVENUE')`,
  );
  const invoicedEncounters = await scalar(pool, `SELECT count(*)::int AS n FROM billing.invoice WHERE status IN ('finalised','part_paid','paid')`);
  const stockouts = alerts.filter((a) => a.flags.includes('stockout')).length;

  const kpis: Kpi[] = [
    { id: 'visits', label: 'Patient visits', value: visits, unit: 'count', owner: 'Clinic manager', formula: 'count(visits in period)' },
    { id: 'recognised_revenue', label: 'Recognised revenue', value: recognisedRevenueMinor, unit: 'USD minor', owner: 'Finance officer', formula: 'sum(revenue account credits - debits)' },
    { id: 'outstanding_debtors', label: 'Outstanding debtors', value: ageing.totalMinor, unit: 'USD minor', owner: 'Finance officer', formula: 'sum(open invoice lines - allocations), reconciled to AR control' },
    { id: 'ar_reconciles', label: 'Debtors reconcile to ledger', value: ageing.reconciles ? 1 : 0, unit: 'boolean', owner: 'Finance officer', formula: 'ageing total == AR control account' },
    { id: 'stockouts', label: 'SKUs at zero stock', value: stockouts, unit: 'count', owner: 'Stock controller', formula: 'count(products with on-hand <= 0)' },
    { id: 'open_critical_results', label: 'Unacknowledged critical results', value: critical.length, unit: 'count', owner: 'Clinical lead', formula: 'count(critical results without acknowledgement)' },
    { id: 'pending_sync', label: 'Pending sync items', value: pendingSync, unit: 'count', owner: 'System administrator', formula: 'count(outbox items in queued state)' },
    { id: 'completed_visits', label: 'Completed visits', value: completedVisits, unit: 'count', owner: 'Clinic manager', formula: "count(visits with status='complete')" },
    { id: 'invoiced_encounters', label: 'Finalised invoices', value: invoicedEncounters, unit: 'count', owner: 'Finance officer', formula: 'count(invoices finalised/part-paid/paid)' },
  ];

  // Exceptions first — each links to an actionable queue (MGT-003).
  const exceptions: Exception[] = [];
  if (critical.length > 0) exceptions.push({ type: 'open_critical_results', label: 'Unacknowledged critical results', count: critical.length, queue: '/api/orders/critical/outstanding', owner: 'Clinical lead' });
  if (alerts.length > 0) exceptions.push({ type: 'stock_alerts', label: 'Stock alerts (stockout/low/expiry)', count: alerts.length, queue: '/api/stock/alerts', owner: 'Stock controller' });
  if (ageing.workQueue.length > 0) exceptions.push({ type: 'debtors', label: 'Patients with outstanding balances', count: ageing.workQueue.length, queue: '/api/debtors/ageing', owner: 'Finance officer' });
  if (pendingSync > 0) exceptions.push({ type: 'pending_sync', label: 'Changes awaiting synchronisation', count: pendingSync, queue: '/api/sync/status', owner: 'System administrator' });
  if (!ageing.reconciles) exceptions.push({ type: 'ar_mismatch', label: 'Debtors do not reconcile to the ledger', count: 1, queue: '/api/debtors/ageing', owner: 'Finance officer' });

  return { asOf, kpis, exceptions };
}

export type ManagementExport = {
  asOf: string;
  filters: Record<string, string>;
  confidentiality: string;
  exportedBy: string;
  format: string;
  dashboard: Dashboard;
};

/**
 * Export a management pack (MGT-007, UAT-15). The envelope carries the as-of time,
 * filters, owner and confidentiality label; the export itself is audited (bulk
 * export of aggregate data). Patient-level detail is not included here.
 */
export async function exportDashboard(
  pool: Pool,
  args: { asOf: string; exportedBy: string; filters?: Record<string, string>; format?: 'json' | 'csv' | 'pdf' },
): Promise<ManagementExport> {
  const dash = await dashboard(pool, args.asOf);
  const envelope: ManagementExport = {
    asOf: args.asOf,
    filters: args.filters ?? {},
    confidentiality: 'management-only',
    exportedBy: args.exportedBy,
    format: args.format ?? 'json',
    dashboard: dash,
  };
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'export','management_report','success',$3, now(), $4)`,
    [uuidv7(), args.exportedBy, `management pack as-of ${args.asOf} (${envelope.format})`, 'mgmt-export:' + uuidv7()],
  );
  return envelope;
}
