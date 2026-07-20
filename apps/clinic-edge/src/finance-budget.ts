/**
 * Budgets & variance (FIN-007, pack §10.5). A budget sets an expected amount for
 * an account in a period; variance compares it to the ACTUAL posted to that
 * account's journal lines in the period. Actuals derive from the immutable ledger
 * (debit-positive net), so variance always reconciles to the general ledger.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class BudgetError extends Error {}

/** Set (or replace) a budget line for an account + period (optionally by site). */
export async function setBudget(pool: Pool, args: { accountCode: string; periodId: string; amountMinor: number; site?: string; by?: string }): Promise<{ id: string }> {
  if (!Number.isInteger(args.amountMinor)) throw new BudgetError('amount must be an integer minor unit');
  const acc = await pool.query(`SELECT 1 FROM finance.account WHERE code=$1`, [args.accountCode]);
  if (acc.rowCount === 0) throw new BudgetError(`unknown account ${args.accountCode}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id FROM finance.budget WHERE account_code=$1 AND period_id=$2 AND site_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
      [args.accountCode, args.periodId, args.site ?? null],
    );
    let id: string;
    if ((existing.rowCount ?? 0) > 0) {
      id = existing.rows[0].id;
      await client.query(`UPDATE finance.budget SET amount_minor=$2 WHERE id=$1`, [id, args.amountMinor]);
    } else {
      id = uuidv7();
      await client.query(`INSERT INTO finance.budget (id, account_code, period_id, site_id, amount_minor, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, args.accountCode, args.periodId, args.site ?? null, args.amountMinor, args.by ?? null]);
    }
    await client.query('COMMIT');
    return { id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type VarianceRow = { accountCode: string; name: string; budgetMinor: number; actualMinor: number; varianceMinor: number; variancePct: number | null };

/**
 * Budget vs actual variance for a period (FIN-007). Actual is the account's
 * debit-positive net from journal lines in the period; variance = actual − budget.
 */
export async function budgetVariance(pool: Pool, args: { periodId: string }): Promise<{ periodId: string; rows: VarianceRow[]; totalBudgetMinor: number; totalActualMinor: number }> {
  const r = await pool.query(
    `SELECT b.account_code, a.name, b.amount_minor::bigint AS budget,
            coalesce((
              SELECT sum(l.debit_minor) - sum(l.credit_minor)
              FROM finance.journal_line l JOIN finance.journal_batch jb ON jb.id = l.batch_id
              WHERE l.account_code = b.account_code AND jb.period_id = b.period_id
            ),0)::bigint AS actual
     FROM finance.budget b JOIN finance.account a ON a.code = b.account_code
     WHERE b.period_id = $1
     ORDER BY b.account_code`,
    [args.periodId],
  );
  const rows: VarianceRow[] = r.rows.map((x) => {
    const budgetMinor = Number(x.budget);
    const actualMinor = Number(x.actual);
    const varianceMinor = actualMinor - budgetMinor;
    return { accountCode: x.account_code, name: x.name, budgetMinor, actualMinor, varianceMinor, variancePct: budgetMinor === 0 ? null : Math.round((varianceMinor / budgetMinor) * 10000) / 100 };
  });
  return {
    periodId: args.periodId,
    rows,
    totalBudgetMinor: rows.reduce((s, x) => s + x.budgetMinor, 0),
    totalActualMinor: rows.reduce((s, x) => s + x.actualMinor, 0),
  };
}
