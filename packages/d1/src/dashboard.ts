/**
 * Management command centre on D1 (MGT-001/003/008): exceptions first, then KPIs,
 * every figure derived live from the ledgers/records — nothing stored/editable.
 * Ported from the Postgres edge `management.ts`, computing the subset of KPIs and
 * exceptions that the currently-ported D1 tables support (visits, revenue,
 * invoices, stock, patients, sync). KPIs that depend on not-yet-ported modules
 * (debtor ageing, critical results, charge-capture, sync conflicts) are added
 * back as those modules are ported — the shape the screen consumes is unchanged.
 */
import type { D1Database } from './d1.ts';
import { one } from './query.ts';

export type Kpi = { id: string; label: string; value: number; unit: string; owner: string; formula: string };
export type Exception = { type: string; label: string; count: number; queue: string; owner: string };
export type Dashboard = { asOf: string; kpis: Kpi[]; exceptions: Exception[] };

async function scalar(db: D1Database, sql: string, params: unknown[] = []): Promise<number> {
  const r = await one<{ n: number }>(db, sql, params);
  return Number(r?.n ?? 0);
}

export async function dashboard(db: D1Database, asOf: string): Promise<Dashboard> {
  const visits = await scalar(db, `SELECT count(*) AS n FROM flow_visit`);
  const completedVisits = await scalar(db, `SELECT count(*) AS n FROM flow_visit WHERE status='complete'`);
  const patients = await scalar(db, `SELECT count(*) AS n FROM identity_patient WHERE deceased = 0`);
  const recognisedRevenueMinor = await scalar(
    db,
    `SELECT COALESCE(SUM(credit_minor)-SUM(debit_minor),0) AS n FROM finance_journal_line WHERE account_code IN ('4000-SERVICE-REVENUE','4010-MEDICINE-REVENUE')`,
  );
  const invoicedEncounters = await scalar(db, `SELECT count(*) AS n FROM billing_invoice WHERE status IN ('finalised','part_paid','paid')`);
  const stockouts = await scalar(
    db,
    `SELECT count(*) AS n FROM (SELECT sku FROM inventory_stock_balance GROUP BY sku HAVING COALESCE(SUM(on_hand),0) <= 0)`,
  );

  const kpis: Kpi[] = [
    { id: 'visits', label: 'Patient visits', value: visits, unit: 'count', owner: 'Clinic manager', formula: 'count(visits)' },
    { id: 'completed_visits', label: 'Completed visits', value: completedVisits, unit: 'count', owner: 'Clinic manager', formula: "count(visits with status='complete')" },
    { id: 'registered_patients', label: 'Registered patients', value: patients, unit: 'count', owner: 'Clinic manager', formula: 'count(living patients)' },
    { id: 'recognised_revenue', label: 'Recognised revenue', value: recognisedRevenueMinor, unit: 'USD minor', owner: 'Finance officer', formula: 'sum(revenue account credits - debits)' },
    { id: 'invoiced_encounters', label: 'Finalised invoices', value: invoicedEncounters, unit: 'count', owner: 'Finance officer', formula: 'count(invoices finalised/part-paid/paid)' },
    { id: 'stockouts', label: 'SKUs at zero stock', value: stockouts, unit: 'count', owner: 'Stock controller', formula: 'count(SKUs with on-hand <= 0)' },
    { id: 'pending_sync', label: 'Pending sync items', value: 0, unit: 'count', owner: 'System administrator', formula: 'cloud-native — writes commit directly (no outbox)' },
  ];

  // Exceptions first — each links to an actionable queue (MGT-003).
  const exceptions: Exception[] = [];
  if (stockouts > 0) exceptions.push({ type: 'stock_alerts', label: 'SKUs at zero stock', count: stockouts, queue: '/api/stock', owner: 'Stock controller' });

  return { asOf, kpis, exceptions };
}
