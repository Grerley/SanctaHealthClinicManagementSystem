/**
 * Cashier shift operations on D1 (BIL-009, UAT-09). Open a shift; close it against
 * the immutable payment record with a physical denomination count, a variance, a
 * supervisor-approval gate above tolerance (domain `closeShift` throws when
 * approval is required but absent), and a cash-over/short journal posting. The
 * shift never edits payments. Ported from the Postgres edge `cashier.ts`.
 *
 * D1 translations: FOR UPDATE + interactive tx → a status read then the close +
 * journal + audit + outbox committed as one db.batch(); the expected cash comes
 * from the immutable payment rows scoped to the shift.
 */
import { uuidv7, money, reverse, closeShift as computeClose, postCashShortage, CashierError, type Denomination } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';

export class ShiftError extends Error {}
export { CashierError };

export async function openShift(db: D1Database, args: { cashier: string; site?: string; openingFloatMinor: number }): Promise<{ shiftId: string }> {
  const shiftId = uuidv7();
  await db.prepare(`INSERT INTO billing_cashier_shift (id, cashier, site_id, status, opening_float_minor) VALUES (?,?,?,'open',?)`)
    .bind(shiftId, args.cashier, args.site ?? null, args.openingFloatMinor).run();
  return { shiftId };
}

export type CloseShiftResult = { shiftId: string; expectedMinor: number; countedMinor: number; varianceMinor: number; requiresApproval: boolean; approved: boolean; status: 'closed' };

/** Close a shift: expected cash from the shift's own cash payments, take the
 * counted denominations, post a cash-over/short journal on any variance. Throws if
 * not open, or if variance exceeds tolerance without an approver (BIL-009). */
export async function closeCashierShift(
  db: D1Database,
  args: { shiftId: string; denominations: readonly Denomination[]; toleranceMinor: number; approver?: string; postingDate?: string },
): Promise<CloseShiftResult> {
  const shift = await one<{ status: string; opening_float_minor: number }>(db, `SELECT status, opening_float_minor FROM billing_cashier_shift WHERE id=?`, [args.shiftId]);
  if (!shift) throw new ShiftError('shift not found');
  if (shift.status !== 'open') throw new ShiftError('shift is not open');
  const openingFloatMinor = Number(shift.opening_float_minor);

  const rec = await one<{ n: number }>(db, `SELECT COALESCE(SUM(amount_minor),0) AS n FROM billing_payment WHERE shift_id=? AND method='cash'`, [args.shiftId]);
  const cashReceiptsMinor = Number(rec?.n ?? 0);

  // Domain computes expected, variance and the approval gate (throws over tolerance without approver).
  const result = computeClose(
    { openingFloatMinor, cashReceiptsMinor, cashPayOutsMinor: 0, denominations: args.denominations, toleranceMinor: args.toleranceMinor },
    args.approver === undefined ? {} : { approver: args.approver },
  );

  const postingDate = args.postingDate ?? new Date().toISOString().slice(0, 10);
  const periodId = postingDate.slice(0, 7);
  const statements = [];
  if (result.varianceMinor !== 0) {
    await ensurePeriod(db, periodId);
    const shortage = postCashShortage({ batchId: uuidv7(), postingDate }, args.shiftId, money(Math.abs(result.varianceMinor)));
    const batch = result.varianceMinor < 0 ? shortage : reverse(shortage, uuidv7(), postingDate); // short: Dr over/short Cr cash; over: reverse
    statements.push(...journalStatements(db, batch, periodId));
  }
  statements.push(stmt(db, `UPDATE billing_cashier_shift SET status='closed', counted_minor=?, expected_minor=?, variance_minor=?, approved_by=?, closed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='open'`,
    [result.countedMinor, result.expectedMinor, result.varianceMinor, args.approver ?? null, args.shiftId]));
  statements.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','cashier_shift',?,'success',?,?)`,
    [uuidv7(), args.approver ?? null, args.shiftId, `variance ${result.varianceMinor}`, 'shift:' + args.shiftId]));
  statements.push(stmt(db, `INSERT INTO security_sync_outbox_item (idempotency_key, entity_type, entity_id, priority, payload) VALUES (?, 'cashier_shift', ?, 40, ?)`,
    ['shift-close:' + args.shiftId, args.shiftId, JSON.stringify({ shiftId: args.shiftId, variance: result.varianceMinor })]));
  await db.batch(statements);
  return { shiftId: args.shiftId, ...result };
}
