/**
 * Encounter-to-charge completeness on D1 (BIL-002/012, BR-004, UAT-07). Every
 * billable SIGNED encounter must reach exactly one charge outcome — charged,
 * bundled, sponsor-funded, waived or non-billable — the last four only with an
 * authorised reason + approver. A signed billable encounter still 'pending' is a
 * charge-capture gap (revenue leakage) surfaced at day close and on the command
 * centre. Nothing edits a charge silently; exceptions record reason + approver.
 * Ported from the Postgres edge `billing-completeness.ts`.
 *
 * D1 translations: boolean billable → INTEGER 0/1; guarded UPDATEs (WHERE
 * billable=1) are the lock-free concurrency gate; the exception path posts the
 * status change + audit atomically via db.batch().
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

export class ChargeError extends Error {}

export type ChargeException = 'bundled' | 'sponsor' | 'waived' | 'non_billable';

/** Mark an encounter as billable (a chargeable service was performed). */
export async function markBillable(db: D1Database, encounterId: string): Promise<void> {
  const changed = await run(db, `UPDATE clinical_encounter SET billable=1 WHERE id=?`, [encounterId]);
  if (changed === 0) throw new ChargeError('encounter not found');
}

/** Link a finalised invoice as the charge outcome (BIL-002). */
export async function linkCharge(db: D1Database, args: { encounterId: string; invoiceId: string }): Promise<void> {
  const changed = await run(db, `UPDATE clinical_encounter SET charge_status='charged', charge_invoice_id=? WHERE id=? AND billable=1`, [args.invoiceId, args.encounterId]);
  if (changed === 0) throw new ChargeError('billable encounter not found');
}

/** Authorise a non-charge outcome with a reason + approver (BR-004). */
export async function authoriseException(
  db: D1Database,
  args: { encounterId: string; outcome: ChargeException; reason: string; approver: string },
): Promise<void> {
  if (!args.reason) throw new ChargeError('a charge exception requires a reason');
  if (!args.approver) throw new ChargeError('a charge exception requires an approver');
  const enc = await one<{ id: string }>(db, `SELECT id FROM clinical_encounter WHERE id=? AND billable=1`, [args.encounterId]);
  if (!enc) throw new ChargeError('billable encounter not found');
  await db.batch([
    stmt(db, `UPDATE clinical_encounter SET charge_status=?, charge_exception_reason=?, charge_exception_by=? WHERE id=? AND billable=1`,
      [args.outcome, args.reason, args.approver, args.encounterId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','charge_exception',?,'success',?,?)`,
      [uuidv7(), args.approver, args.encounterId, `${args.outcome}: ${args.reason}`, 'charge-exc:' + args.encounterId]),
  ]);
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
export async function chargeCaptureReport(db: D1Database): Promise<ChargeCaptureReport> {
  const where = `WHERE billable=1 AND status='signed'`;
  const total = await one<{ n: number }>(db, `SELECT count(*) AS n FROM clinical_encounter ${where}`);
  const charged = await one<{ n: number }>(db, `SELECT count(*) AS n FROM clinical_encounter ${where} AND charge_status='charged'`);
  const exc = await one<{ n: number }>(db, `SELECT count(*) AS n FROM clinical_encounter ${where} AND charge_status IN ('bundled','sponsor','waived','non_billable')`);
  const gaps = await many<{ id: string; patient_id: string; signed_at: string | null }>(db,
    `SELECT id, patient_id, signed_at FROM clinical_encounter ${where} AND charge_status='pending' ORDER BY signed_at`);
  const billableCompleted = Number(total?.n ?? 0);
  const chargedN = Number(charged?.n ?? 0);
  const excN = Number(exc?.n ?? 0);
  const resolved = chargedN + excN;
  return {
    billableCompleted,
    charged: chargedN,
    authorisedExceptions: excN,
    gaps: gaps.map((r) => ({ encounterId: r.id, patientId: r.patient_id, signedAt: r.signed_at })),
    completenessPct: billableCompleted === 0 ? 100 : Math.round((resolved / billableCompleted) * 1000) / 10,
  };
}
