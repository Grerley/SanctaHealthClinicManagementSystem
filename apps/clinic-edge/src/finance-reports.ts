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
