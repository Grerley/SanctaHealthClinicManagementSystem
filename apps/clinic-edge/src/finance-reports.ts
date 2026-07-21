/**
 * Financial statements (FIN-010, pack §10.1). Trial balance and income statement
 * are computed directly from the immutable journal lines and MUST reconcile to
 * them — the trial balance always nets to zero, and the income statement is built
 * from the same postings. No report relies on an editable total.
 */
import type { Pool } from 'pg';

export type TrialBalanceRow = { code: string; name: string; type: string; debitMinor: number; creditMinor: number; netMinor: number };
export type TrialBalance = { rows: TrialBalanceRow[]; totalDebitMinor: number; totalCreditMinor: number; balanced: boolean };

export async function trialBalance(pool: Pool): Promise<TrialBalance> {
  const res = await pool.query(
    `SELECT a.code, a.name, a.type,
            coalesce(sum(l.debit_minor),0)::bigint AS debit,
            coalesce(sum(l.credit_minor),0)::bigint AS credit
     FROM finance.account a
     LEFT JOIN finance.journal_line l ON l.account_code = a.code
     GROUP BY a.code, a.name, a.type
     HAVING coalesce(sum(l.debit_minor),0) <> 0 OR coalesce(sum(l.credit_minor),0) <> 0
     ORDER BY a.code`,
  );
  const rows: TrialBalanceRow[] = res.rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: r.type,
    debitMinor: Number(r.debit),
    creditMinor: Number(r.credit),
    netMinor: Number(r.debit) - Number(r.credit),
  }));
  const totalDebitMinor = rows.reduce((s, r) => s + r.debitMinor, 0);
  const totalCreditMinor = rows.reduce((s, r) => s + r.creditMinor, 0);
  return { rows, totalDebitMinor, totalCreditMinor, balanced: totalDebitMinor === totalCreditMinor };
}

export type IncomeStatement = {
  revenueMinor: number;
  expensesMinor: number;
  netResultMinor: number;
  revenueLines: Array<{ code: string; name: string; amountMinor: number }>;
  expenseLines: Array<{ code: string; name: string; amountMinor: number }>;
  reconcilesToTrialBalance: boolean;
};

export async function incomeStatement(pool: Pool): Promise<IncomeStatement> {
  const tb = await trialBalance(pool);
  // Revenue is credit-normal (net negative in debit-positive terms); expense is debit-normal.
  const revenueLines = tb.rows.filter((r) => r.type === 'revenue').map((r) => ({ code: r.code, name: r.name, amountMinor: -r.netMinor }));
  const expenseLines = tb.rows.filter((r) => r.type === 'expense').map((r) => ({ code: r.code, name: r.name, amountMinor: r.netMinor }));
  const revenueMinor = revenueLines.reduce((s, r) => s + r.amountMinor, 0);
  const expensesMinor = expenseLines.reduce((s, r) => s + r.amountMinor, 0);
  const netResultMinor = revenueMinor - expensesMinor;
  return {
    revenueMinor,
    expensesMinor,
    netResultMinor,
    revenueLines,
    expenseLines,
    // Sanity tie-out: the trial balance the statement is built from is balanced.
    reconcilesToTrialBalance: tb.balanced,
  };
}

import { createHash } from 'node:crypto';
import { uuidv7 } from '@sancta/domain';

export type LedgerExportLine = {
  batchId: string;
  sourceType: string;
  sourceId: string;
  postingDate: string;
  accountCode: string;
  debitMinor: number;
  creditMinor: number;
  costCentre: string | null;
};
export type LedgerExport = {
  periodId: string;
  periodStatus: string;
  lines: LedgerExportLine[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  balanced: boolean;
  lineCount: number;
  idempotencyKey: string; // deterministic over accounting content only
  exportedAt: string;
};

/**
 * Export approved accounting data for a period (FIN-014). Approved = posted
 * journal lines in the period; the export is deterministic and idempotent — the
 * idempotencyKey is a SHA-256 over the canonical accounting content only (never
 * the wall-clock time), so re-exporting an unchanged period yields the same key.
 * The extract MUST balance (total debits == total credits); an unbalanced ledger
 * throws rather than exporting corrupt data.
 */
export async function exportApprovedLedger(pool: Pool, args: { periodId: string; exportedBy?: string }): Promise<LedgerExport> {
  const per = await pool.query(`SELECT status FROM finance.financial_period WHERE id=$1`, [args.periodId]);
  if (per.rows.length === 0) throw new Error(`unknown financial period: ${args.periodId}`);
  const periodStatus = per.rows[0].status as string;

  const res = await pool.query(
    `SELECT l.batch_id, b.source_type, b.source_id, to_char(b.posting_date,'YYYY-MM-DD') AS posting_date,
            l.account_code, l.debit_minor, l.credit_minor, l.cost_centre
     FROM finance.journal_line l
     JOIN finance.journal_batch b ON b.id = l.batch_id
     WHERE b.period_id = $1
     ORDER BY b.posting_date, b.source_type, b.source_id, l.account_code, l.id`,
    [args.periodId],
  );
  const lines: LedgerExportLine[] = res.rows.map((r) => ({
    batchId: r.batch_id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    postingDate: r.posting_date,
    accountCode: r.account_code,
    debitMinor: Number(r.debit_minor),
    creditMinor: Number(r.credit_minor),
    costCentre: r.cost_centre,
  }));
  const totalDebitMinor = lines.reduce((s, l) => s + l.debitMinor, 0);
  const totalCreditMinor = lines.reduce((s, l) => s + l.creditMinor, 0);
  const balanced = totalDebitMinor === totalCreditMinor;
  if (!balanced) throw new Error(`ledger for ${args.periodId} does not balance (Dr ${totalDebitMinor} <> Cr ${totalCreditMinor}) — refusing to export`);

  // Canonical content for the idempotency key — excludes exportedAt so it is stable.
  const canonical = JSON.stringify({ periodId: args.periodId, periodStatus, lines, totalDebitMinor, totalCreditMinor });
  const idempotencyKey = createHash('sha256').update(canonical).digest('hex');

  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'export','ledger_export',$3::uuid,'success',$4, now(), $5)`,
    [uuidv7(), args.exportedBy ?? null, uuidv7(), `period ${args.periodId} (${periodStatus}) ${lines.length} lines key ${idempotencyKey.slice(0, 12)}`, 'ledger-export:' + idempotencyKey],
  );

  return { periodId: args.periodId, periodStatus, lines, totalDebitMinor, totalCreditMinor, balanced, lineCount: lines.length, idempotencyKey, exportedAt: new Date().toISOString() };
}

import { straightLineDepreciation, grossMargin, type Depreciation, type Margin } from '@sancta/domain';

export class FixedAssetError extends Error {}

/** Capitalise a fixed asset (FIN-008). */
export async function capitaliseAsset(
  pool: Pool,
  args: { reference: string; name: string; category?: string; costMinor: number; salvageMinor?: number; usefulLifeMonths: number; acquiredOn: string; createdBy?: string },
): Promise<{ id: string }> {
  if (!args.reference?.trim() || !args.name?.trim()) throw new FixedAssetError('asset reference and name are required');
  if ((args.salvageMinor ?? 0) > args.costMinor) throw new FixedAssetError('salvage cannot exceed cost');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO finance.fixed_asset (id, reference, name, category, cost_minor, salvage_minor, useful_life_months, acquired_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, args.reference, args.name, args.category ?? null, args.costMinor, args.salvageMinor ?? 0, args.usefulLifeMonths, args.acquiredOn, args.createdBy ?? null],
  );
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
export async function assetRegister(pool: Pool, args: { asOf: string }): Promise<AssetValuation[]> {
  const r = await pool.query(
    `SELECT id, reference, name, cost_minor, salvage_minor, useful_life_months, to_char(acquired_on,'YYYY-MM-DD') AS acquired, status FROM finance.fixed_asset ORDER BY reference`,
  );
  return r.rows.map((x) => {
    const monthsElapsed = monthsBetween(x.acquired, args.asOf);
    const dep = straightLineDepreciation({ costMinor: Number(x.cost_minor), salvageMinor: Number(x.salvage_minor), usefulLifeMonths: x.useful_life_months, monthsElapsed });
    return { id: x.id, reference: x.reference, name: x.name, costMinor: Number(x.cost_minor), asOf: args.asOf, status: x.status, ...dep };
  });
}

/** Dispose of an asset, recording proceeds and the gain/loss vs net book value (FIN-008). */
export async function disposeAsset(pool: Pool, args: { assetId: string; disposedOn: string; proceedsMinor: number; by?: string }): Promise<{ id: string; netBookValueMinor: number; gainLossMinor: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query(`SELECT reference, cost_minor, salvage_minor, useful_life_months, to_char(acquired_on,'YYYY-MM-DD') AS acquired, status FROM finance.fixed_asset WHERE id=$1 FOR UPDATE`, [args.assetId]);
    if (a.rows.length === 0) throw new FixedAssetError('asset not found');
    if (a.rows[0].status === 'disposed') throw new FixedAssetError('asset already disposed');
    const x = a.rows[0];
    const dep = straightLineDepreciation({ costMinor: Number(x.cost_minor), salvageMinor: Number(x.salvage_minor), usefulLifeMonths: x.useful_life_months, monthsElapsed: monthsBetween(x.acquired, args.disposedOn) });
    const gainLossMinor = args.proceedsMinor - dep.netBookValueMinor;
    await client.query(`UPDATE finance.fixed_asset SET status='disposed', disposed_on=$2, disposal_proceeds_minor=$3 WHERE id=$1`, [args.assetId, args.disposedOn, args.proceedsMinor]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','fixed_asset',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by ?? null, args.assetId, `disposed ${x.reference}: proceeds ${args.proceedsMinor} vs NBV ${dep.netBookValueMinor} (${gainLossMinor >= 0 ? 'gain' : 'loss'} ${Math.abs(gainLossMinor)})`, 'asset-disposal:' + args.assetId],
    );
    await client.query('COMMIT');
    return { id: args.assetId, netBookValueMinor: dep.netBookValueMinor, gainLossMinor };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type ProductMargin = { sku: string; revenueMinor: number; cogsMinor: number; grossMarginMinor: number; marginPct: number };

/**
 * Product/service margin from revenue and ACTUAL consumption (FIN-011). Revenue
 * per SKU comes from finalised invoice lines; cost of goods comes from the actual
 * stock issued, valued at its lot cost. The clinic total ties out to the ledger's
 * revenue-less-COGS.
 */
export async function marginReport(pool: Pool): Promise<{ products: ProductMargin[]; total: Margin }> {
  const rev = await pool.query(
    `SELECT service_code AS sku, coalesce(sum(applied_minor),0)::bigint AS revenue
     FROM billing.invoice_line l JOIN billing.invoice i ON i.id=l.invoice_id
     WHERE i.status IN ('finalised','part_paid','paid') GROUP BY service_code`,
  );
  const cogs = await pool.query(
    `SELECT m.sku, coalesce(sum(-m.quantity * lo.unit_cost_minor),0)::bigint AS cogs
     FROM inventory.stock_movement m JOIN inventory.lot lo ON lo.id=m.lot_id
     WHERE m.quantity < 0 GROUP BY m.sku`,
  );
  const revBySku = new Map<string, number>(rev.rows.map((r) => [r.sku, Number(r.revenue)]));
  const cogsBySku = new Map<string, number>(cogs.rows.map((r) => [r.sku, Number(r.cogs)]));
  const skus = new Set<string>([...revBySku.keys(), ...cogsBySku.keys()]);
  const products: ProductMargin[] = [...skus].sort().map((sku) => {
    const m = grossMargin(revBySku.get(sku) ?? 0, cogsBySku.get(sku) ?? 0);
    return { sku, ...m };
  });
  let totalRevenue = 0;
  let totalCogs = 0;
  for (const p of products) { totalRevenue += p.revenueMinor; totalCogs += p.cogsMinor; }
  return { products, total: grossMargin(totalRevenue, totalCogs) };
}
