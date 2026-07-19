/**
 * Triage / vitals capture on the edge (TRI-002/003, UAT-03). Opens a triage
 * visit + draft encounter for a patient and records a validated set of vitals.
 * Implausible values must be confirmed (not silently dropped); the recorded row
 * keeps the value and its flag so the timeline shows what was entered and that it
 * was confirmed.
 */
import type { Pool } from 'pg';
import { uuidv7, validateVitals, type VitalInput, type VitalValidation } from '@sancta/domain';

const DEFAULT_SITE = '00000000-0000-7000-8000-0000000000f1';

export type RecordVitalsBody = {
  patientId: string;
  vitals: VitalInput[];
  confirmed?: boolean;
  user?: string;
  site?: string;
};

export type RecordVitalsResult = {
  encounterId: string;
  visitId: string;
  observations: VitalValidation[];
};

/**
 * Validate and persist a vitals set atomically. Throws (VitalError) if an
 * implausible value is submitted without confirmation — the caller re-presents it
 * for confirmation rather than losing the data.
 */
export async function recordVitals(pool: Pool, body: RecordVitalsBody): Promise<RecordVitalsResult> {
  // Domain validation first — may throw before any write.
  const results = validateVitals(body.vitals, body.confirmed === undefined ? {} : { confirmed: body.confirmed });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const visitId = uuidv7();
    const encounterId = uuidv7();
    const site = body.site ?? DEFAULT_SITE;
    await client.query(`INSERT INTO flow.visit (id, patient_id, visit_number, site_id, status) VALUES ($1,$2,$3,$4,'in_triage')`, [
      visitId,
      body.patientId,
      'V-' + visitId.slice(-12),
      site,
    ]);
    await client.query(
      `INSERT INTO clinical.encounter (id, visit_id, patient_id, status, form_version) VALUES ($1,$2,$3,'draft',1)`,
      [encounterId, visitId, body.patientId],
    );
    for (const r of results) {
      await client.query(
        `INSERT INTO clinical.observation (id, encounter_id, patient_id, kind, value, unit, flag, confirmed, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), encounterId, body.patientId, r.kind, r.value, r.unit, r.flag, r.requiresConfirmation ? Boolean(body.confirmed) : false, body.user ?? null],
      );
    }
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','triage',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), body.user ?? null, encounterId, body.patientId, `${results.length} observations`, 'triage:' + encounterId],
    );
    await client.query('COMMIT');
    return { encounterId, visitId, observations: results };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
