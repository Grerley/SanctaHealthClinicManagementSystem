/**
 * Encounter-to-charge completeness (BIL-002/012, BR-004, UAT-07). Every billable
 * completed (signed) encounter must reach exactly one charge outcome — charged,
 * bundled, sponsor-funded, waived or non-billable — the last four only with an
 * authorised reason. A signed billable encounter still 'pending' is a
 * charge-capture gap (revenue leakage) surfaced at day close and on the command
 * centre. Nothing edits a charge silently; exceptions record reason + approver.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class ChargeError extends Error {}

export type ChargeException = 'bundled' | 'sponsor' | 'waived' | 'non_billable';

/** Mark an encounter as billable (a chargeable service was performed). */
export async function markBillable(pool: Pool, encounterId: string): Promise<void> {
  const r = await pool.query(`UPDATE clinical.encounter SET billable=true WHERE id=$1`, [encounterId]);
  if (r.rowCount === 0) throw new ChargeError('encounter not found');
}

/** Link a finalised invoice as the charge outcome (BIL-002). */
export async function linkCharge(pool: Pool, args: { encounterId: string; invoiceId: string }): Promise<void> {
  const r = await pool.query(
    `UPDATE clinical.encounter SET charge_status='charged', charge_invoice_id=$2
     WHERE id=$1 AND billable=true`,
    [args.encounterId, args.invoiceId],
  );
  if (r.rowCount === 0) throw new ChargeError('billable encounter not found');
}

/** Authorise a non-charge outcome with a reason + approver (BR-004). */
export async function authoriseException(
  pool: Pool,
  args: { encounterId: string; outcome: ChargeException; reason: string; approver: string },
): Promise<void> {
  if (!args.reason) throw new ChargeError('a charge exception requires a reason');
  if (!args.approver) throw new ChargeError('a charge exception requires an approver');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE clinical.encounter SET charge_status=$2, charge_exception_reason=$3, charge_exception_by=$4
       WHERE id=$1 AND billable=true`,
      [args.encounterId, args.outcome, args.reason, args.approver],
    );
    if (r.rowCount === 0) throw new ChargeError('billable encounter not found');
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','charge_exception',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.approver, args.encounterId, `${args.outcome}: ${args.reason}`, 'charge-exc:' + args.encounterId],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type ChargeGap = { encounterId: string; patientId: string; signedAt: string | null };

export type ChargeCaptureReport = {
  billableCompleted: number;
  charged: number;
  authorisedExceptions: number;
  gaps: ChargeGap[];
  completenessPct: number; // (charged + authorised exceptions) / billable completed
};

/**
 * Charge-capture reconciliation for the day close (BIL-012). Only SIGNED billable
 * encounters count as "completed billable"; a 'pending' one is a gap.
 */
export async function chargeCaptureReport(pool: Pool): Promise<ChargeCaptureReport> {
  const base = `FROM clinical.encounter WHERE billable=true AND status='signed'`;
  const total = await pool.query(`SELECT count(*)::int AS n ${base}`);
  const charged = await pool.query(`SELECT count(*)::int AS n ${base} AND charge_status='charged'`);
  const exc = await pool.query(`SELECT count(*)::int AS n ${base} AND charge_status IN ('bundled','sponsor','waived','non_billable')`);
  const gapsRes = await pool.query(
    `SELECT id, patient_id, to_char(signed_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS signed_at ${base} AND charge_status='pending' ORDER BY signed_at`,
  );
  const billableCompleted = total.rows[0].n as number;
  const chargedN = charged.rows[0].n as number;
  const excN = exc.rows[0].n as number;
  const resolved = chargedN + excN;
  return {
    billableCompleted,
    charged: chargedN,
    authorisedExceptions: excN,
    gaps: gapsRes.rows.map((r) => ({ encounterId: r.id, patientId: r.patient_id, signedAt: r.signed_at })),
    completenessPct: billableCompleted === 0 ? 100 : Math.round((resolved / billableCompleted) * 1000) / 10,
  };
}
