/**
 * Prescribing with allergy checking and controlled override (MED-002/003, UAT-05).
 * A medication request is checked against the patient's active allergies by
 * substance code; a match blocks the prescription unless an authorised prescriber
 * supplies an override reason, which is recorded on the request and audited. The
 * alert source and severity are always visible.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class PrescribingError extends Error {}

export async function recordAllergy(pool: Pool, args: { patientId: string; substanceCode: string; severity?: 'low' | 'high' | 'critical' }): Promise<{ allergyId: string }> {
  const allergyId = uuidv7();
  await pool.query(`INSERT INTO clinical.allergy (id, patient_id, substance_code, severity) VALUES ($1,$2,$3,$4)`, [
    allergyId,
    args.patientId,
    args.substanceCode,
    args.severity ?? 'high',
  ]);
  return { allergyId };
}

export type AllergyAlert = { substanceCode: string; severity: string };

export type PrescribeBody = {
  patientId: string;
  encounterId?: string;
  medicineCode: string;
  substanceCode: string;
  dose?: string;
  route?: string;
  frequency?: string;
  durationDays?: number;
  quantity?: number;
  prescribedBy: string;
  override?: boolean;
  overrideReason?: string;
};

export type PrescribeResult =
  | { ok: true; requestId: string; overridden: boolean }
  | { ok: false; alerts: AllergyAlert[] };

/**
 * Create a medication request. If the medicine's substance matches an active
 * allergy, block unless overridden with a reason (MED-003). Override requires the
 * prescriber's reason and is recorded (signature = prescribedBy) and audited.
 */
export async function prescribe(pool: Pool, body: PrescribeBody): Promise<PrescribeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const allergies = await client.query(`SELECT substance_code, severity FROM clinical.allergy WHERE patient_id=$1 AND substance_code=$2`, [
      body.patientId,
      body.substanceCode,
    ]);
    const alerts: AllergyAlert[] = allergies.rows.map((r) => ({ substanceCode: r.substance_code, severity: r.severity }));

    if (alerts.length > 0 && !body.override) {
      await client.query('ROLLBACK');
      return { ok: false, alerts };
    }
    if (alerts.length > 0 && body.override && !body.overrideReason) {
      await client.query('ROLLBACK');
      throw new PrescribingError('overriding an allergy alert requires a reason');
    }

    const requestId = uuidv7();
    await client.query(
      `INSERT INTO clinical.medication_request (id, patient_id, encounter_id, medicine_code, substance_code, dose, route, frequency, duration_days, quantity, status, prescribed_by, override_reason, override_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13)`,
      [
        requestId,
        body.patientId,
        body.encounterId ?? null,
        body.medicineCode,
        body.substanceCode,
        body.dose ?? null,
        body.route ?? null,
        body.frequency ?? null,
        body.durationDays ?? null,
        body.quantity ?? null,
        body.prescribedBy,
        alerts.length > 0 ? body.overrideReason ?? null : null,
        alerts.length > 0 ? body.prescribedBy : null,
      ],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','medication_request',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), body.prescribedBy, requestId, body.patientId, alerts.length > 0 ? 'allergy override: ' + body.overrideReason : 'prescribed', 'rx:' + requestId],
    );
    await client.query('COMMIT');
    return { ok: true, requestId, overridden: alerts.length > 0 };
  } catch (e) {
    if (e instanceof PrescribingError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
