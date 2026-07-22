/**
 * Month-end close loop and balance sheet on D1 (FIN-004/010). Close computes the
 * period's net result from the immutable journal lines, posts a balanced closing
 * batch that clears temporary accounts to retained earnings (domain
 * `closingJournalLines`), then hard-closes the period. The balance sheet derives
 * from the same ledger and MUST balance by the double-entry identity — never a
 * stored total. A period cannot be closed twice. Ported from the Postgres edge
 * `finance-close.ts`.
 *
 * D1 translations: FOR UPDATE + interactive tx → a status read then the closing
 * batch + period hard-close in one db.batch(); posting reuses journalStatements.
 */
import { uuidv7, closingJournalLines, assertPostable, type JournalBatch } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';
import { FinanceError, PeriodClosedError } from './finance.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;
const RETAINED_EARNINGS = '3000-RETAINED-EARNINGS';

export type BalanceSheet = {
  asOfPeriod: string | null; assetsMinor: number; liabilitiesMinor: number; equityMinor: number;
  retainedAndCurrentEarningsMinor: number; balances: boolean;
  lines: Array<{ code: string; name: string; type: string; amountMinor: number }>;
};

/** Cumulative balance sheet across all posted journals — equity includes current
 * (unclosed) earnings so it balances whether or not the period has been closed. */
export async function balanceSheet(db: D1Database): Promise<BalanceSheet> {
  const rows = await many<{ code: string; name: string; type: string; net: number }>(
    db,
    `SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit_minor),0) - COALESCE(SUM(l.credit_minor),0) AS net
     FROM finance_account a LEFT JOIN finance_journal_line l ON l.account_code = a.code
     GROUP BY a.code, a.name, a.type
     HAVING COALESCE(SUM(l.debit_minor),0) <> 0 OR COALESCE(SUM(l.credit_minor),0) <> 0
     ORDER BY a.code`,
  );
  const r = rows.map((x) => ({ code: x.code, name: x.name, type: x.type, netMinor: Number(x.net) }));
  const assetsMinor = r.filter((x) => x.type === 'asset').reduce((s, x) => s + x.netMinor, 0);
  const liabilitiesMinor = r.filter((x) => x.type === 'liability').reduce((s, x) => s - x.netMinor, 0);
  const equityAccountsMinor = r.filter((x) => x.type === 'equity').reduce((s, x) => s - x.netMinor, 0);
  const revenueMinor = r.filter((x) => x.type === 'revenue').reduce((s, x) => s - x.netMinor, 0);
  const expenseMinor = r.filter((x) => x.type === 'expense').reduce((s, x) => s + x.netMinor, 0);
  const retainedAndCurrentEarningsMinor = equityAccountsMinor + (revenueMinor - expenseMinor);
  const equityMinor = retainedAndCurrentEarningsMinor;
  const lines = r.map((x) => ({ code: x.code, name: x.name, type: x.type, amountMinor: x.type === 'asset' || x.type === 'expense' ? x.netMinor : -x.netMinor }));
  return { asOfPeriod: null, assetsMinor, liabilitiesMinor, equityMinor, retainedAndCurrentEarningsMinor, balances: assetsMinor === liabilitiesMinor + equityMinor, lines };
}

export type MonthlyClose = { periodId: string; revenueMinor: number; expensesMinor: number; netResultMinor: number; closingBatchId: string | null; status: 'hard_close' };

/** Account net balances (debit-positive) scoped to one period. */
async function periodBalances(db: D1Database, periodId: string): Promise<Array<{ code: string; type: string; netMinor: number }>> {
  const rows = await many<{ code: string; type: string; net: number }>(
    db,
    `SELECT a.code, a.type, COALESCE(SUM(l.debit_minor),0) - COALESCE(SUM(l.credit_minor),0) AS net
     FROM finance_account a JOIN finance_journal_line l ON l.account_code = a.code JOIN finance_journal_batch b ON b.id = l.batch_id
     WHERE b.period_id = ? GROUP BY a.code, a.type`,
    [periodId],
  );
  return rows.map((x) => ({ code: x.code, type: x.type, netMinor: Number(x.net) }));
}

/** Close a period: post the closing entry (temporary accounts → retained earnings)
 * then hard-close. Requires an approver (BR-011). Refuses a second close. */
export async function monthlyClose(db: D1Database, args: { periodId: string; approver: string }): Promise<MonthlyClose> {
  if (!args.approver) throw new FinanceError('closing a period requires an authorised approver');
  const pr = await one<{ status: string }>(db, `SELECT status FROM finance_financial_period WHERE id=?`, [args.periodId]);
  if (pr && pr.status === 'hard_close') throw new PeriodClosedError(`period ${args.periodId} is already closed`);
  await ensurePeriod(db, args.periodId);

  const balances = await periodBalances(db, args.periodId);
  const revenue = balances.filter((b) => b.type === 'revenue').map((b) => ({ code: b.code, amountMinor: -b.netMinor }));
  const expense = balances.filter((b) => b.type === 'expense').map((b) => ({ code: b.code, amountMinor: b.netMinor }));
  const closing = closingJournalLines(revenue, expense, RETAINED_EARNINGS);

  const statements = [];
  let closingBatchId: string | null = null;
  if (closing.lines.length > 0) {
    const batch: JournalBatch = { id: uuidv7(), origin: 'manual', source: { type: 'period_close', id: args.periodId }, currency: 'USD', postingDate: `${args.periodId}-28`, lines: closing.lines };
    assertPostable(batch);
    closingBatchId = batch.id;
    statements.push(...journalStatements(db, batch, args.periodId));
  }
  statements.push(stmt(db, `UPDATE finance_financial_period SET status='hard_close', closed_at=${NOW} WHERE id=?`, [args.periodId]));
  statements.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','financial_period',?,'success',?,?)`,
    [uuidv7(), args.approver, args.periodId, `monthly close ${args.periodId}: net ${closing.netResultMinor} (batch ${closingBatchId ?? 'none'})`, 'monthly-close:' + args.periodId]));
  await db.batch(statements);
  return { periodId: args.periodId, revenueMinor: closing.revenueMinor, expensesMinor: closing.expensesMinor, netResultMinor: closing.netResultMinor, closingBatchId, status: 'hard_close' };
}
