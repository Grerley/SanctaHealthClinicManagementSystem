/**
 * Cashier shift operations on the edge PostgreSQL (BIL-009, UAT-09). Opening a
 * shift, and closing it against the immutable payment record with a physical
 * denomination count, a variance, a supervisor-approval gate above tolerance, and
 * a cash-over/short journal posting. The shift never edits payments.
 */
import type { Pool, PoolClient } from 'pg';
import {
  uuidv7,
  money,
  reverse,
  closeShift as computeClose,
  type Denomination,
  postCashShortage,
} from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';

const DEFAULT_SITE = '00000000-0000-7000-8000-0000000000f1';
const DEFAULT_DEVICE = '00000000-0000-7000-8000-0000000000d1';
const DEFAULT_USER = '00000000-0000-7000-8000-0000000000e1';

export async function openShift(pool: Pool, args: { cashier: string; site?: string; openingFloatMinor: number }): Promise<{ shiftId: string }> {
  const shiftId = uuidv7();
  await pool.query(
    `INSERT INTO billing.cashier_shift (id, cashier, site_id, status, opening_float_minor) VALUES ($1,$2,$3,'open',$4)`,
    [shiftId, args.cashier, args.site ?? null, args.openingFloatMinor],
  );
  return { shiftId };
}

export class ShiftError extends Error {}

export type OpenShiftRow = {
  shiftId: string; cashier: string; site: string | null; openedAt: string;
  openingFloatMinor: number; cashReceiptsMinor: number; paymentCount: number; expectedMinor: number;
};

/**
 * Open shifts with their expected cash drawer (BIL-009). Expected is derived live
 * from the immutable cash payments scoped to each shift plus the opening float —
 * never a stored running total. Read-only; no reconciliation is implied until the
 * shift is actually closed with a physical count.
 */
export async function listOpenShifts(pool: Pool, args?: { cashier?: string }): Promise<{ shifts: OpenShiftRow[] }> {
  const params: unknown[] = [];
  let where = `s.status='open'`;
  if (args?.cashier) { params.push(args.cashier); where += ` AND s.cashier=$${params.length}`; }
  const r = await pool.query(
    `SELECT s.id, s.cashier, s.site_id, s.opened_at, s.opening_float_minor,
            coalesce(p.cash_receipts_minor, 0)::bigint AS cash_receipts_minor,
            coalesce(p.payment_count, 0)::bigint AS payment_count
       FROM billing.cashier_shift s
       LEFT JOIN (
         SELECT shift_id, sum(amount_minor) AS cash_receipts_minor, count(*) AS payment_count
           FROM billing.payment WHERE method='cash' AND shift_id IS NOT NULL GROUP BY shift_id
       ) p ON p.shift_id = s.id
      WHERE ${where}
      ORDER BY s.opened_at ASC`,
    params,
  );
  return {
    shifts: r.rows.map((x) => {
      const openingFloatMinor = Number(x.opening_float_minor);
      const cashReceiptsMinor = Number(x.cash_receipts_minor);
      return {
        shiftId: x.id, cashier: x.cashier, site: x.site_id,
        openedAt: x.opened_at instanceof Date ? x.opened_at.toISOString() : String(x.opened_at),
        openingFloatMinor, cashReceiptsMinor, paymentCount: Number(x.payment_count),
        expectedMinor: openingFloatMinor + cashReceiptsMinor,
      };
    }),
  };
}

export type CloseShiftResult = {
  shiftId: string;
  expectedMinor: number;
  countedMinor: number;
  varianceMinor: number;
  requiresApproval: boolean;
  approved: boolean;
  status: 'closed';
};

/**
 * Close a shift. Computes expected cash from the shift's own cash payments, takes
 * the counted denominations, and posts a cash-over/short journal when they differ.
 * Throws if the shift is not open, or if the variance exceeds tolerance without an
 * approver (BIL-009: no close with unresolved variance above tolerance).
 */
export async function closeCashierShift(
  pool: Pool,
  args: {
    shiftId: string;
    denominations: readonly Denomination[];
    toleranceMinor: number;
    approver?: string;
    postingDate?: string;
  },
): Promise<CloseShiftResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the shift row; reject if not open (idempotent, no double-close).
    const shiftRes = await client.query(
      `SELECT status, opening_float_minor FROM billing.cashier_shift WHERE id=$1 FOR UPDATE`,
      [args.shiftId],
    );
    if (shiftRes.rows.length === 0) throw new ShiftError('shift not found');
    if (shiftRes.rows[0].status !== 'open') throw new ShiftError('shift is not open');
    const openingFloatMinor = Number(shiftRes.rows[0].opening_float_minor);

    // Expected cash from the immutable payment record (cash only).
    const recRes = await client.query(
      `SELECT coalesce(sum(amount_minor),0)::bigint AS n FROM billing.payment WHERE shift_id=$1 AND method='cash'`,
      [args.shiftId],
    );
    const cashReceiptsMinor = Number(recRes.rows[0].n);

    // Domain computes expected, variance and the approval gate.
    const result = computeClose(
      { openingFloatMinor, cashReceiptsMinor, cashPayOutsMinor: 0, denominations: args.denominations, toleranceMinor: args.toleranceMinor },
      args.approver === undefined ? {} : { approver: args.approver },
    );

    const postingDate = args.postingDate ?? '2026-07-19';
    // Post the cash over/short journal when there is a variance.
    if (result.varianceMinor !== 0) {
      const magnitude = Math.abs(result.varianceMinor);
      const shortage = postCashShortage({ batchId: uuidv7(), postingDate }, args.shiftId, money(magnitude));
      // Short: Dr cash over/short, Cr cash (as built). Over: the reverse.
      const batch = result.varianceMinor < 0 ? shortage : reverse(shortage, uuidv7(), postingDate);
      await insertJournalBatch(client, batch, postingDate.slice(0, 7));
    }

    await client.query(
      `UPDATE billing.cashier_shift
       SET status='closed', counted_minor=$2, expected_minor=$3, variance_minor=$4, approved_by=$5, closed_at=now()
       WHERE id=$1`,
      [args.shiftId, result.countedMinor, result.expectedMinor, result.varianceMinor, args.approver ?? null],
    );

    // Audit + outbox for sync.
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','cashier_shift',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.approver ?? null, args.shiftId, `variance ${result.varianceMinor}`, 'shift:' + args.shiftId],
    );
    await client.query(
      `INSERT INTO security_sync.outbox_item (idempotency_key, entity_type, entity_id, entity_version, origin_site, device_id, user_id, schema_version, priority, dependencies, captured_at, payload)
       VALUES ($1,'cashier_shift',$2,1,$3,$4,$5,1,40,'{}', now(), $6)`,
      [
        'shift-close:' + args.shiftId,
        args.shiftId,
        DEFAULT_SITE,
        DEFAULT_DEVICE,
        args.approver ?? DEFAULT_USER,
        JSON.stringify({ shiftId: args.shiftId, variance: result.varianceMinor }),
      ],
    );

    await client.query('COMMIT');
    return { shiftId: args.shiftId, ...result };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
