/**
 * Budgets & variance on D1 (FIN-007). A budget sets an expected amount for an
 * account in a period; variance compares it to the ACTUAL debit-positive net
 * posted to that account's journal lines in the period, so variance always
 * reconciles to the general ledger. Ported from the Postgres edge
 * `finance-budget.ts`.
 *
 * D1 translations: `site_id IS NOT DISTINCT FROM ?` → SQLite's null-safe `IS ?`;
 * FOR UPDATE upsert → read-then-update-or-insert.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many } from './query.ts';

export class BudgetError extends Error {}

/** Set (or replace) a budget line for an account + period (optionally by site). */
export async function setBudget(db: D1Database, args: { accountCode: string; periodId: string; amountMinor: number; site?: string; by?: string }): Promise<{ id: string }> {
  if (!Number.isInteger(args.amountMinor)) throw new BudgetError('amount must be an integer minor unit');
  const acc = await one(db, `SELECT 1 AS ok FROM finance_account WHERE code=?`, [args.accountCode]);
  if (!acc) throw new BudgetError(`unknown account ${args.accountCode}`);
  const existing = await one<{ id: string }>(db, `SELECT id FROM finance_budget WHERE account_code=? AND period_id=? AND site_id IS ?`, [args.accountCode, args.periodId, args.site ?? null]);
  if (existing) {
    await db.prepare(`UPDATE finance_budget SET amount_minor=? WHERE id=?`).bind(args.amountMinor, existing.id).run();
    return { id: existing.id };
  }
  const id = uuidv7();
  await db.prepare(`INSERT INTO finance_budget (id, account_code, period_id, site_id, amount_minor, created_by) VALUES (?,?,?,?,?,?)`)
    .bind(id, args.accountCode, args.periodId, args.site ?? null, args.amountMinor, args.by ?? null).run();
  return { id };
}

export type VarianceRow = { accountCode: string; name: string; budgetMinor: number; actualMinor: number; varianceMinor: number; variancePct: number | null };

/** Budget vs actual variance for a period (FIN-007). Actual = account's
 * debit-positive net from journal lines in the period; variance = actual − budget. */
export async function budgetVariance(db: D1Database, args: { periodId: string }): Promise<{ periodId: string; rows: VarianceRow[]; totalBudgetMinor: number; totalActualMinor: number }> {
  const res = await many<{ account_code: string; name: string; budget: number; actual: number }>(
    db,
    `SELECT b.account_code, a.name, b.amount_minor AS budget,
            COALESCE((
              SELECT SUM(l.debit_minor) - SUM(l.credit_minor)
              FROM finance_journal_line l JOIN finance_journal_batch jb ON jb.id = l.batch_id
              WHERE l.account_code = b.account_code AND jb.period_id = b.period_id
            ),0) AS actual
     FROM finance_budget b JOIN finance_account a ON a.code = b.account_code
     WHERE b.period_id = ? ORDER BY b.account_code`,
    [args.periodId],
  );
  const rows: VarianceRow[] = res.map((x) => {
    const budgetMinor = Number(x.budget);
    const actualMinor = Number(x.actual);
    const varianceMinor = actualMinor - budgetMinor;
    return { accountCode: x.account_code, name: x.name, budgetMinor, actualMinor, varianceMinor, variancePct: budgetMinor === 0 ? null : Math.round((varianceMinor / budgetMinor) * 10000) / 100 };
  });
  return { periodId: args.periodId, rows, totalBudgetMinor: rows.reduce((s, x) => s + x.budgetMinor, 0), totalActualMinor: rows.reduce((s, x) => s + x.actualMinor, 0) };
}
