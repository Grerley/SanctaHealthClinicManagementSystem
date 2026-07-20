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
