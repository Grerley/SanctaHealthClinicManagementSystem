/**
 * Period-close journal construction (FIN-004 close loop, pack §10.1).
 *
 * At month end the temporary accounts (revenue, expense) are closed to equity so
 * the next period starts from zero while the balance sheet carries forward. This
 * builds the balanced closing batch lines deterministically from the period's
 * revenue and expense balances:
 *
 *   - each revenue account (credit-normal) is debited by its balance → back to nil
 *   - each expense account (debit-normal) is credited by its balance → back to nil
 *   - the net result (revenue − expense) posts to retained earnings: a profit
 *     credits equity, a loss debits it
 *
 * The result always balances (Σ debit == Σ credit); `assertPostable` in ledger.ts
 * is the final guard when it is posted.
 */
import { type JournalLine } from './ledger.ts';
import { money } from './money.ts';

/** An account code with its period balance in minor units (always non-negative). */
export type AccountBalance = { code: string; amountMinor: number };

export type ClosingResult = {
  lines: JournalLine[];
  revenueMinor: number;
  expensesMinor: number;
  netResultMinor: number;
};

/**
 * Build the closing journal lines. `revenue`/`expense` carry each temporary
 * account's period balance (positive = normal side). `retainedEarningsCode` is
 * the equity account that absorbs the net result.
 */
export function closingJournalLines(
  revenue: readonly AccountBalance[],
  expense: readonly AccountBalance[],
  retainedEarningsCode: string,
  currency = 'USD',
): ClosingResult {
  const lines: JournalLine[] = [];

  // Debit each revenue account to clear its credit balance.
  let revenueMinor = 0;
  for (const r of revenue) {
    if (r.amountMinor === 0) continue;
    revenueMinor += r.amountMinor;
    lines.push({ accountCode: r.code, debit: money(r.amountMinor, currency), credit: money(0, currency), memo: 'period close' });
  }

  // Credit each expense account to clear its debit balance.
  let expensesMinor = 0;
  for (const e of expense) {
    if (e.amountMinor === 0) continue;
    expensesMinor += e.amountMinor;
    lines.push({ accountCode: e.code, debit: money(0, currency), credit: money(e.amountMinor, currency), memo: 'period close' });
  }

  // Net result to retained earnings: profit credits equity, loss debits it.
  const netResultMinor = revenueMinor - expensesMinor;
  if (netResultMinor > 0) {
    lines.push({ accountCode: retainedEarningsCode, debit: money(0, currency), credit: money(netResultMinor, currency), memo: 'net result to retained earnings' });
  } else if (netResultMinor < 0) {
    lines.push({ accountCode: retainedEarningsCode, debit: money(-netResultMinor, currency), credit: money(0, currency), memo: 'net loss to retained earnings' });
  }

  return { lines, revenueMinor, expensesMinor, netResultMinor };
}
