/**
 * Financial statements + fixed assets + margin on D1 (FIN-008/010/011/014). Trial
 * balance and income statement are computed directly from the immutable journal
 * lines and MUST reconcile to them; the ledger export is deterministic/idempotent
 * (SHA-256 over accounting content only); margin ties revenue to ACTUAL stock
 * consumption. Ported from the Postgres edge `finance-reports.ts`; all arithmetic
 * uses the same domain helpers.
 *
 * D1 translations: HAVING/GROUP-BY read the same; node:crypto works under
 * nodejs_compat (Worker) and natively (tests); FOR UPDATE on disposal → an
 * optimistic WHERE status='active' guard.
 */
import { uuidv7, straightLineDepreciation, grossMargin, type Depreciation, type Margin } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run } from './query.ts';

/** SHA-256 hex via Web Crypto (native in Workers and Node 22) — keeps the barrel
 * node-free while giving a deterministic idempotency key. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type TrialBalanceRow = { code: string; name: string; type: string; debitMinor: number; creditMinor: number; netMinor: number };
export type TrialBalance = { rows: TrialBalanceRow[]; totalDebitMinor: number; totalCreditMinor: number; balanced: boolean };

export async function trialBalance(db: D1Database): Promise<TrialBalance> {
  const res = await many<{ code: string; name: string; type: string; debit: number; credit: number }>(
    db,
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(l.debit_minor),0) AS debit, COALESCE(SUM(l.credit_minor),0) AS credit
     FROM finance_account a LEFT JOIN finance_journal_line l ON l.account_code = a.code
     GROUP BY a.code, a.name, a.type
     HAVING COALESCE(SUM(l.debit_minor),0) <> 0 OR COALESCE(SUM(l.credit_minor),0) <> 0
     ORDER BY a.code`,
  );
  const rows: TrialBalanceRow[] = res.map((r) => ({
    code: r.code, name: r.name, type: r.type,
    debitMinor: Number(r.debit), creditMinor: Number(r.credit), netMinor: Number(r.debit) - Number(r.credit),
  }));
  const totalDebitMinor = rows.reduce((s, r) => s + r.debitMinor, 0);
  const totalCreditMinor = rows.reduce((s, r) => s + r.creditMinor, 0);
  return { rows, totalDebitMinor, totalCreditMinor, balanced: totalDebitMinor === totalCreditMinor };
}

export type IncomeStatement = {
  revenueMinor: number; expensesMinor: number; netResultMinor: number;
  revenueLines: Array<{ code: string; name: string; amountMinor: number }>;
  expenseLines: Array<{ code: string; name: string; amountMinor: number }>;
  reconcilesToTrialBalance: boolean;
};

export async function incomeStatement(db: D1Database): Promise<IncomeStatement> {
  const tb = await trialBalance(db);
  const revenueLines = tb.rows.filter((r) => r.type === 'revenue').map((r) => ({ code: r.code, name: r.name, amountMinor: -r.netMinor }));
  const expenseLines = tb.rows.filter((r) => r.type === 'expense').map((r) => ({ code: r.code, name: r.name, amountMinor: r.netMinor }));
  const revenueMinor = revenueLines.reduce((s, r) => s + r.amountMinor, 0);
  const expensesMinor = expenseLines.reduce((s, r) => s + r.amountMinor, 0);
  return { revenueMinor, expensesMinor, netResultMinor: revenueMinor - expensesMinor, revenueLines, expenseLines, reconcilesToTrialBalance: tb.balanced };
}

export type LedgerExportLine = { batchId: string; sourceType: string; sourceId: string; postingDate: string; accountCode: string; debitMinor: number; creditMinor: number; costCentre: string | null };
export type LedgerExport = { periodId: string; periodStatus: string; lines: LedgerExportLine[]; totalDebitMinor: number; totalCreditMinor: number; balanced: boolean; lineCount: number; idempotencyKey: string; exportedAt: string };

/** Export approved (posted) journal lines for a period (FIN-014). Deterministic:
 * the idempotencyKey is a SHA-256 over accounting content only. Must balance. */
export async function exportApprovedLedger(db: D1Database, args: { periodId: string; exportedBy?: string }): Promise<LedgerExport> {
  const per = await one<{ status: string }>(db, `SELECT status FROM finance_financial_period WHERE id=?`, [args.periodId]);
  if (!per) throw new Error(`unknown financial period: ${args.periodId}`);
  const periodStatus = per.status;
  const res = await many<{ batch_id: string; source_type: string; source_id: string; posting_date: string; account_code: string; debit_minor: number; credit_minor: number; cost_centre: string | null }>(
    db,
    `SELECT l.batch_id, b.source_type, b.source_id, b.posting_date, l.account_code, l.debit_minor, l.credit_minor, l.cost_centre
     FROM finance_journal_line l JOIN finance_journal_batch b ON b.id = l.batch_id
     WHERE b.period_id = ? ORDER BY b.posting_date, b.source_type, b.source_id, l.account_code, l.id`,
    [args.periodId],
  );
  const lines: LedgerExportLine[] = res.map((r) => ({
    batchId: r.batch_id, sourceType: r.source_type, sourceId: r.source_id, postingDate: r.posting_date,
    accountCode: r.account_code, debitMinor: Number(r.debit_minor), creditMinor: Number(r.credit_minor), costCentre: r.cost_centre,
  }));
  const totalDebitMinor = lines.reduce((s, l) => s + l.debitMinor, 0);
  const totalCreditMinor = lines.reduce((s, l) => s + l.creditMinor, 0);
  const balanced = totalDebitMinor === totalCreditMinor;
  if (!balanced) throw new Error(`ledger for ${args.periodId} does not balance (Dr ${totalDebitMinor} <> Cr ${totalCreditMinor}) — refusing to export`);
  const canonical = JSON.stringify({ periodId: args.periodId, periodStatus, lines, totalDebitMinor, totalCreditMinor });
  const idempotencyKey = await sha256Hex(canonical);
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'export','ledger_export',?,'success',?,?)`)
    .bind(uuidv7(), args.exportedBy ?? null, uuidv7(), `period ${args.periodId} (${periodStatus}) ${lines.length} lines key ${idempotencyKey.slice(0, 12)}`, 'ledger-export:' + idempotencyKey).run();
  return { periodId: args.periodId, periodStatus, lines, totalDebitMinor, totalCreditMinor, balanced, lineCount: lines.length, idempotencyKey, exportedAt: new Date().toISOString() };
}

export class FixedAssetError extends Error {}

/** Capitalise a fixed asset (FIN-008). */
export async function capitaliseAsset(
  db: D1Database,
  args: { reference: string; name: string; category?: string; costMinor: number; salvageMinor?: number; usefulLifeMonths: number; acquiredOn: string; createdBy?: string },
): Promise<{ id: string }> {
  if (!args.reference?.trim() || !args.name?.trim()) throw new FixedAssetError('asset reference and name are required');
  if ((args.salvageMinor ?? 0) > args.costMinor) throw new FixedAssetError('salvage cannot exceed cost');
  const id = uuidv7();
  try {
    await db.prepare(`INSERT INTO finance_fixed_asset (id, reference, name, category, cost_minor, salvage_minor, useful_life_months, acquired_on, created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, args.reference, args.name, args.category ?? null, args.costMinor, args.salvageMinor ?? 0, args.usefulLifeMonths, args.acquiredOn, args.createdBy ?? null).run();
  } catch (e) {
    if (/UNIQUE|CHECK/i.test(String((e as Error).message))) throw new FixedAssetError(`asset rejected: ${(e as Error).message}`);
    throw e;
  }
  return { id };
}

function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + 'T00:00:00Z');
  const b = new Date(toIso + 'T00:00:00Z');
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months--;
  return Math.max(0, months);
}

export type AssetValuation = { id: string; reference: string; name: string; costMinor: number; asOf: string; status: string } & Depreciation;

/** Depreciation + net book value for every asset as-of a date (FIN-008). */
export async function assetRegister(db: D1Database, args: { asOf: string }): Promise<AssetValuation[]> {
  const rows = await many<{ id: string; reference: string; name: string; cost_minor: number; salvage_minor: number; useful_life_months: number; acquired: string; status: string }>(
    db, `SELECT id, reference, name, cost_minor, salvage_minor, useful_life_months, acquired_on AS acquired, status FROM finance_fixed_asset ORDER BY reference`);
  return rows.map((x) => {
    const dep = straightLineDepreciation({ costMinor: Number(x.cost_minor), salvageMinor: Number(x.salvage_minor), usefulLifeMonths: x.useful_life_months, monthsElapsed: monthsBetween(x.acquired, args.asOf) });
    return { id: x.id, reference: x.reference, name: x.name, costMinor: Number(x.cost_minor), asOf: args.asOf, status: x.status, ...dep };
  });
}

/** Dispose of an asset, recording proceeds and gain/loss vs net book value (FIN-008). */
export async function disposeAsset(db: D1Database, args: { assetId: string; disposedOn: string; proceedsMinor: number; by?: string }): Promise<{ id: string; netBookValueMinor: number; gainLossMinor: number }> {
  const x = await one<{ reference: string; cost_minor: number; salvage_minor: number; useful_life_months: number; acquired: string; status: string }>(
    db, `SELECT reference, cost_minor, salvage_minor, useful_life_months, acquired_on AS acquired, status FROM finance_fixed_asset WHERE id=?`, [args.assetId]);
  if (!x) throw new FixedAssetError('asset not found');
  if (x.status === 'disposed') throw new FixedAssetError('asset already disposed');
  const dep = straightLineDepreciation({ costMinor: Number(x.cost_minor), salvageMinor: Number(x.salvage_minor), usefulLifeMonths: x.useful_life_months, monthsElapsed: monthsBetween(x.acquired, args.disposedOn) });
  const gainLossMinor = args.proceedsMinor - dep.netBookValueMinor;
  const changed = await run(db, `UPDATE finance_fixed_asset SET status='disposed', disposed_on=?, disposal_proceeds_minor=? WHERE id=? AND status='active'`, [args.disposedOn, args.proceedsMinor, args.assetId]);
  if (changed === 0) throw new FixedAssetError('asset already disposed');
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','fixed_asset',?,'success',?,?)`)
    .bind(uuidv7(), args.by ?? null, args.assetId, `disposed ${x.reference}: proceeds ${args.proceedsMinor} vs NBV ${dep.netBookValueMinor} (${gainLossMinor >= 0 ? 'gain' : 'loss'} ${Math.abs(gainLossMinor)})`, 'asset-disposal:' + args.assetId).run();
  return { id: args.assetId, netBookValueMinor: dep.netBookValueMinor, gainLossMinor };
}

export type ProductMargin = { sku: string; revenueMinor: number; cogsMinor: number; grossMarginMinor: number; marginPct: number };

/** Product/service margin from revenue and ACTUAL consumption (FIN-011). */
export async function marginReport(db: D1Database): Promise<{ products: ProductMargin[]; total: Margin }> {
  const rev = await many<{ sku: string; revenue: number }>(
    db, `SELECT service_code AS sku, COALESCE(SUM(applied_minor),0) AS revenue
         FROM billing_invoice_line l JOIN billing_invoice i ON i.id=l.invoice_id
         WHERE i.status IN ('finalised','part_paid','paid') GROUP BY service_code`);
  const cogs = await many<{ sku: string; cogs: number }>(
    db, `SELECT m.sku, COALESCE(SUM(-m.quantity * lo.unit_cost_minor),0) AS cogs
         FROM inventory_stock_movement m JOIN inventory_lot lo ON lo.id=m.lot_id
         WHERE m.quantity < 0 GROUP BY m.sku`);
  const revBySku = new Map<string, number>(rev.map((r) => [r.sku, Number(r.revenue)]));
  const cogsBySku = new Map<string, number>(cogs.map((r) => [r.sku, Number(r.cogs)]));
  const skus = new Set<string>([...revBySku.keys(), ...cogsBySku.keys()]);
  const products: ProductMargin[] = [...skus].sort().map((sku) => ({ sku, ...grossMargin(revBySku.get(sku) ?? 0, cogsBySku.get(sku) ?? 0) }));
  let totalRevenue = 0, totalCogs = 0;
  for (const p of products) { totalRevenue += p.revenueMinor; totalCogs += p.cogsMinor; }
  return { products, total: grossMargin(totalRevenue, totalCogs) };
}
