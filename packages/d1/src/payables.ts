/**
 * Expenses & accounts payable on D1 (FIN-005/006, UAT-12). An approved expense
 * creates a payable and posts Dr expense / Cr supplier-AP; paying it posts Dr AP /
 * Cr cash and settles the payable. The AP subledger (open payables) reconciles to
 * the GL supplier-AP control account. Requires an approver (BR-011). Ported from
 * the Postgres edge `payables.ts`; the same domain posting accounts are used.
 *
 * D1 translations: interactive tx + FOR UPDATE → db.batch() with a status read
 * then a status-guarded settle; posting goes through the shared choke point
 * (ensurePeriod + assertPeriodOpen + journalStatements).
 */
import { uuidv7, money, assertPostable, ACCOUNTS, type JournalBatch } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';
import { assertPeriodOpen } from './finance.ts';

export class PayableError extends Error {}

function today(): string { return new Date().toISOString().slice(0, 10); }

function twoLine(sourceId: string, sourceType: string, debit: string, credit: string, valueMinor: number, postingDate: string): JournalBatch {
  const amount = money(valueMinor);
  const zero = money(0);
  const batch: JournalBatch = {
    id: uuidv7(), origin: 'system', source: { type: sourceType, id: sourceId }, currency: 'USD', postingDate,
    lines: [{ accountCode: debit, debit: amount, credit: zero }, { accountCode: credit, debit: zero, credit: amount }],
  };
  assertPostable(batch);
  return batch;
}

/** Record an approved expense: create a payable and post Dr expense / Cr AP. */
export async function recordExpense(
  db: D1Database,
  args: { category: string; supplier?: string; amountMinor: number; approver?: string; dueDate?: string; postingDate?: string },
): Promise<{ expenseId: string; payableId: string }> {
  if (!args.approver) throw new PayableError('an expense requires an authorised approver');
  if (args.amountMinor <= 0) throw new PayableError('expense amount must be positive');
  const postingDate = args.postingDate ?? today();
  const periodId = postingDate.slice(0, 7);
  await ensurePeriod(db, periodId);
  await assertPeriodOpen(db, periodId);
  const expenseId = uuidv7();
  const payableId = uuidv7();
  const journal = twoLine(expenseId, 'expense', ACCOUNTS.operatingExpense, ACCOUNTS.supplierAP, args.amountMinor, postingDate);
  await db.batch([
    stmt(db, `INSERT INTO finance_expense (id, category, supplier, amount_minor, approved_by) VALUES (?,?,?,?,?)`, [expenseId, args.category, args.supplier ?? null, args.amountMinor, args.approver]),
    stmt(db, `INSERT INTO finance_payable (id, expense_id, supplier, amount_minor, due_date) VALUES (?,?,?,?,?)`, [payableId, expenseId, args.supplier ?? null, args.amountMinor, args.dueDate ?? null]),
    ...journalStatements(db, journal, periodId),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','expense',?,'success',?,?)`, [uuidv7(), args.approver, expenseId, args.category, 'expense:' + expenseId]),
  ]);
  return { expenseId, payableId };
}

/** Pay a supplier payable: post Dr AP / Cr cash and settle the payable. */
export async function paySupplier(db: D1Database, args: { payableId: string; method?: 'cash' | 'bank'; user?: string; postingDate?: string }): Promise<{ paidMinor: number }> {
  const p = await one<{ amount_minor: number; paid_minor: number; status: string }>(db, `SELECT amount_minor, paid_minor, status FROM finance_payable WHERE id=?`, [args.payableId]);
  if (!p) throw new PayableError('payable not found');
  if (p.status === 'paid') throw new PayableError('payable already settled');
  const due = Number(p.amount_minor) - Number(p.paid_minor);
  const postingDate = args.postingDate ?? today();
  const periodId = postingDate.slice(0, 7);
  await ensurePeriod(db, periodId);
  await assertPeriodOpen(db, periodId);
  const creditAccount = args.method === 'bank' ? ACCOUNTS.bankClearing : ACCOUNTS.cash;
  const journal = twoLine(args.payableId, 'supplier-payment', ACCOUNTS.supplierAP, creditAccount, due, postingDate);
  await db.batch([
    ...journalStatements(db, journal, periodId),
    stmt(db, `UPDATE finance_payable SET paid_minor=amount_minor, status='paid' WHERE id=? AND status='open'`, [args.payableId]),
  ]);
  return { paidMinor: due };
}

/** AP subledger open balance and the GL control, with a reconciliation flag. */
export async function apReconciliation(db: D1Database): Promise<{ subledgerMinor: number; controlMinor: number; reconciles: boolean }> {
  const sub = await one<{ n: number }>(db, `SELECT COALESCE(SUM(amount_minor - paid_minor),0) AS n FROM finance_payable WHERE status='open'`);
  const ctl = await one<{ n: number }>(db, `SELECT COALESCE(SUM(credit_minor)-SUM(debit_minor),0) AS n FROM finance_journal_line WHERE account_code='2100-SUPPLIER-AP'`);
  const subledgerMinor = Number(sub?.n ?? 0);
  const controlMinor = Number(ctl?.n ?? 0);
  return { subledgerMinor, controlMinor, reconciles: subledgerMinor === controlMinor };
}
