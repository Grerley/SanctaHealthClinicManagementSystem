/**
 * Month-end close loop and balance sheet (FIN-004, FIN-010, pack §10.1).
 *
 * The close computes the period's net result from the immutable journal lines
 * scoped to that period, posts a balanced closing batch that clears the temporary
 * accounts to retained earnings (domain `closingJournalLines`), then hard-closes
 * the period. The balance sheet is derived from the same ledger and MUST balance
 * (assets = liabilities + equity) by the double-entry identity — never a stored
 * total. A period cannot be closed twice.
 */
import type { Pool } from 'pg';
import { uuidv7, closingJournalLines, assertPostable, type JournalBatch } from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';
import { FinanceError, PeriodClosedError } from './finance.ts';

const RETAINED_EARNINGS = '3000-RETAINED-EARNINGS';

type BalanceRow = { code: string; type: string; netMinor: number };

/** Account net balances (debit-positive) scoped to one period. */
async function periodBalances(pool: Pool, periodId: string): Promise<BalanceRow[]> {
  const r = await pool.query(
    `SELECT a.code, a.type, coalesce(sum(l.debit_minor),0)::bigint - coalesce(sum(l.credit_minor),0)::bigint AS net
     FROM finance.account a
     JOIN finance.journal_line l ON l.account_code = a.code
     JOIN finance.journal_batch b ON b.id = l.batch_id
     WHERE b.period_id = $1
     GROUP BY a.code, a.type`,
    [periodId],
  );
  return r.rows.map((x) => ({ code: x.code, type: x.type, netMinor: Number(x.net) }));
}

export type BalanceSheet = {
  asOfPeriod: string | null;
  assetsMinor: number;
  liabilitiesMinor: number;
  equityMinor: number;
  retainedAndCurrentEarningsMinor: number;
  balances: boolean;
  lines: Array<{ code: string; name: string; type: string; amountMinor: number }>;
};

/**
 * Cumulative balance sheet across all posted journals. Equity includes the
 * current (unclosed) earnings so it balances whether or not the period has been
 * closed — closing merely reclassifies earnings into the retained-earnings account.
 */
export async function balanceSheet(pool: Pool): Promise<BalanceSheet> {
  const r = await pool.query(
    `SELECT a.code, a.name, a.type, coalesce(sum(l.debit_minor),0)::bigint - coalesce(sum(l.credit_minor),0)::bigint AS net
     FROM finance.account a
     LEFT JOIN finance.journal_line l ON l.account_code = a.code
     GROUP BY a.code, a.name, a.type
     HAVING coalesce(sum(l.debit_minor),0) <> 0 OR coalesce(sum(l.credit_minor),0) <> 0
     ORDER BY a.code`,
  );
  const rows = r.rows.map((x) => ({ code: x.code, name: x.name, type: x.type, netMinor: Number(x.net) }));
  const assetsMinor = rows.filter((x) => x.type === 'asset').reduce((s, x) => s + x.netMinor, 0); // debit-positive
  const liabilitiesMinor = rows.filter((x) => x.type === 'liability').reduce((s, x) => s - x.netMinor, 0); // credit-positive
  const equityAccountsMinor = rows.filter((x) => x.type === 'equity').reduce((s, x) => s - x.netMinor, 0);
  const revenueMinor = rows.filter((x) => x.type === 'revenue').reduce((s, x) => s - x.netMinor, 0);
  const expenseMinor = rows.filter((x) => x.type === 'expense').reduce((s, x) => s + x.netMinor, 0);
  const currentEarningsMinor = revenueMinor - expenseMinor;
  const retainedAndCurrentEarningsMinor = equityAccountsMinor + currentEarningsMinor;
  const equityMinor = retainedAndCurrentEarningsMinor;
  const lines = rows.map((x) => ({
    code: x.code,
    name: x.name,
    type: x.type,
    amountMinor: x.type === 'asset' || x.type === 'expense' ? x.netMinor : -x.netMinor,
  }));
  return {
    asOfPeriod: null,
    assetsMinor,
    liabilitiesMinor,
    equityMinor,
    retainedAndCurrentEarningsMinor,
    balances: assetsMinor === liabilitiesMinor + equityMinor,
    lines,
  };
}

export type MonthlyClose = {
  periodId: string;
  revenueMinor: number;
  expensesMinor: number;
  netResultMinor: number;
  closingBatchId: string | null;
  status: 'hard_close';
};

/**
 * Close a period: post the closing entry (temporary accounts → retained earnings)
 * then hard-close. Requires an approver (segregation on the period, BR-011).
 * Refuses to close an already hard-closed period.
 */
export async function monthlyClose(pool: Pool, args: { periodId: string; approver: string }): Promise<MonthlyClose> {
  if (!args.approver) throw new FinanceError('closing a period requires an authorised approver');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the period row; reject a second close.
    const pr = await client.query(`SELECT status FROM finance.financial_period WHERE id=$1 FOR UPDATE`, [args.periodId]);
    if ((pr.rowCount ?? 0) > 0 && pr.rows[0].status === 'hard_close') {
      throw new PeriodClosedError(`period ${args.periodId} is already closed`);
    }

    const balances = await periodBalances(pool, args.periodId);
    const revenue = balances.filter((b) => b.type === 'revenue').map((b) => ({ code: b.code, amountMinor: -b.netMinor })); // credit-normal
    const expense = balances.filter((b) => b.type === 'expense').map((b) => ({ code: b.code, amountMinor: b.netMinor })); // debit-normal
    const closing = closingJournalLines(revenue, expense, RETAINED_EARNINGS);

    let closingBatchId: string | null = null;
    if (closing.lines.length > 0) {
      const batch: JournalBatch = {
        id: uuidv7(),
        origin: 'manual',
        source: { type: 'period_close', id: args.periodId },
        currency: 'USD',
        postingDate: `${args.periodId}-28`,
        lines: closing.lines,
      };
      assertPostable(batch);
      await insertJournalBatch(client, batch, args.periodId); // still open here (BR-010 passes)
      closingBatchId = batch.id;
    }

    await client.query(
      `INSERT INTO finance.financial_period (id, status, closed_at) VALUES ($1,'hard_close', now())
       ON CONFLICT (id) DO UPDATE SET status='hard_close', closed_at=now()`,
      [args.periodId],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','financial_period',$3::uuid,'success',$4, now(), $5)`,
      [uuidv7(), args.approver, uuidv7(), `monthly close ${args.periodId}: net ${closing.netResultMinor} (batch ${closingBatchId ?? 'none'})`, 'monthly-close:' + args.periodId],
    );
    await client.query('COMMIT');
    return {
      periodId: args.periodId,
      revenueMinor: closing.revenueMinor,
      expensesMinor: closing.expensesMinor,
      netResultMinor: closing.netResultMinor,
      closingBatchId,
      status: 'hard_close',
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
