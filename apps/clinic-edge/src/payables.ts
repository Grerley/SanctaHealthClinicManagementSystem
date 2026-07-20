/**
 * Expenses & accounts payable (FIN-005/006, UAT-12). An approved expense creates a
 * payable and posts Dr expense / Cr supplier AP; paying it posts Dr supplier AP /
 * Cr cash. The AP subledger (open payables) reconciles to the GL supplier-AP
 * control account. Requires an approver (segregation, BR-011).
 */
import type { Pool } from 'pg';
import { uuidv7, money, assertPostable, ACCOUNTS, type JournalBatch } from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';

export class PayableError extends Error {}

const POSTING_DATE = '2026-07-19';

function twoLine(sourceId: string, sourceType: string, debit: string, credit: string, valueMinor: number): JournalBatch {
  const amount = money(valueMinor);
  const zero = money(0);
  const batch: JournalBatch = {
    id: uuidv7(),
    origin: 'system',
    source: { type: sourceType, id: sourceId },
    currency: 'USD',
    postingDate: POSTING_DATE,
    lines: [
      { accountCode: debit, debit: amount, credit: zero },
      { accountCode: credit, debit: zero, credit: amount },
    ],
  };
  assertPostable(batch);
  return batch;
}

/** Record an approved expense: create a payable and post Dr expense / Cr AP. */
export async function recordExpense(
  pool: Pool,
  args: { category: string; supplier?: string; amountMinor: number; approver?: string; dueDate?: string },
): Promise<{ expenseId: string; payableId: string }> {
  if (!args.approver) throw new PayableError('an expense requires an authorised approver');
  if (args.amountMinor <= 0) throw new PayableError('expense amount must be positive');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expenseId = uuidv7();
    const payableId = uuidv7();
    await client.query(`INSERT INTO finance.expense (id, category, supplier, amount_minor, approved_by) VALUES ($1,$2,$3,$4,$5)`, [
      expenseId,
      args.category,
      args.supplier ?? null,
      args.amountMinor,
      args.approver,
    ]);
    await client.query(`INSERT INTO finance.payable (id, expense_id, supplier, amount_minor, due_date) VALUES ($1,$2,$3,$4,$5)`, [
      payableId,
      expenseId,
      args.supplier ?? null,
      args.amountMinor,
      args.dueDate ?? null,
    ]);
    await insertJournalBatch(client, twoLine(expenseId, 'expense', ACCOUNTS.operatingExpense, ACCOUNTS.supplierAP, args.amountMinor), POSTING_DATE.slice(0, 7));
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','expense',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.approver, expenseId, args.category, 'expense:' + expenseId],
    );
    await client.query('COMMIT');
    return { expenseId, payableId };
  } catch (e) {
    if (e instanceof PayableError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Pay a supplier payable: post Dr AP / Cr cash and settle the payable. */
export async function paySupplier(pool: Pool, args: { payableId: string; method?: 'cash' | 'bank'; user?: string }): Promise<{ paidMinor: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query(`SELECT amount_minor, paid_minor, status FROM finance.payable WHERE id=$1 FOR UPDATE`, [args.payableId]);
    if (p.rows.length === 0) throw new PayableError('payable not found');
    if (p.rows[0].status === 'paid') throw new PayableError('payable already settled');
    const due = Number(p.rows[0].amount_minor) - Number(p.rows[0].paid_minor);
    const creditAccount = args.method === 'bank' ? ACCOUNTS.bankClearing : ACCOUNTS.cash;
    await insertJournalBatch(client, twoLine(args.payableId, 'supplier-payment', ACCOUNTS.supplierAP, creditAccount, due), POSTING_DATE.slice(0, 7));
    await client.query(`UPDATE finance.payable SET paid_minor=amount_minor, status='paid' WHERE id=$1`, [args.payableId]);
    await client.query('COMMIT');
    return { paidMinor: due };
  } catch (e) {
    if (e instanceof PayableError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** AP subledger open balance and the GL control, with a reconciliation flag. */
export async function apReconciliation(pool: Pool): Promise<{ subledgerMinor: number; controlMinor: number; reconciles: boolean }> {
  const sub = await pool.query(`SELECT coalesce(sum(amount_minor - paid_minor),0)::bigint AS n FROM finance.payable WHERE status='open'`);
  const ctl = await pool.query(`SELECT coalesce(sum(credit_minor)-sum(debit_minor),0)::bigint AS n FROM finance.journal_line WHERE account_code='2100-SUPPLIER-AP'`);
  const subledgerMinor = Number(sub.rows[0].n);
  const controlMinor = Number(ctl.rows[0].n);
  return { subledgerMinor, controlMinor, reconciles: subledgerMinor === controlMinor };
}
