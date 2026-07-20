/**
 * Patient identity history & deceased provenance (PAT-007, pack §6.1).
 *
 * A demographic change never silently overwrites: the previous value, new value
 * and provenance (who, when, why) are recorded in an immutable history, and the
 * patient's live value is updated with an incremented entity version. Death is
 * captured with a date and the recorder, not just a flag.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class IdentityHistoryError extends Error {}

const MUTABLE_FIELDS = ['given_name', 'family_name', 'date_of_birth', 'sex', 'phone'] as const;
type MutableField = (typeof MUTABLE_FIELDS)[number];

/**
 * Change a demographic field, preserving the previous value with provenance.
 * Returns the recorded history entry id. Rejects an unknown field.
 */
export async function changeDemographic(
  pool: Pool,
  args: { patientId: string; field: MutableField; newValue: string | null; reason?: string; by?: string },
): Promise<{ historyId: string; field: string; oldValue: string | null; newValue: string | null }> {
  if (!(MUTABLE_FIELDS as readonly string[]).includes(args.field)) throw new IdentityHistoryError(`field ${args.field} is not an editable demographic`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT ${args.field === 'date_of_birth' ? `to_char(date_of_birth,'YYYY-MM-DD')` : args.field} AS v FROM identity.patient WHERE id=$1 FOR UPDATE`,
      [args.patientId],
    );
    if (cur.rowCount === 0) throw new IdentityHistoryError(`patient ${args.patientId} not found`);
    const oldValue = cur.rows[0].v ?? null;

    await client.query(`UPDATE identity.patient SET ${args.field}=$2, entity_version = entity_version + 1, updated_at = now() WHERE id=$1`, [args.patientId, args.newValue]);
    const historyId = uuidv7();
    await client.query(
      `INSERT INTO identity.patient_identity_history (id, patient_id, field, old_value, new_value, reason, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [historyId, args.patientId, args.field, oldValue, args.newValue, args.reason ?? null, args.by ?? null],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','patient',$3,$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by ?? null, args.patientId, `${args.field}: "${oldValue ?? ''}" → "${args.newValue ?? ''}"${args.reason ? ' (' + args.reason + ')' : ''}`, 'idhist:' + historyId],
    );
    await client.query('COMMIT');
    return { historyId, field: args.field, oldValue, newValue: args.newValue };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Record a patient's death with date + provenance (PAT-007). Idempotent-guarded. */
export async function markDeceased(
  pool: Pool,
  args: { patientId: string; deceasedAt: string; reason?: string; by?: string },
): Promise<{ patientId: string; deceasedAt: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT deceased FROM identity.patient WHERE id=$1 FOR UPDATE`, [args.patientId]);
    if (cur.rowCount === 0) throw new IdentityHistoryError(`patient ${args.patientId} not found`);
    if (cur.rows[0].deceased === true) throw new IdentityHistoryError('patient is already recorded as deceased');
    await client.query(`UPDATE identity.patient SET deceased=true, deceased_at=$2, deceased_recorded_by=$3, entity_version = entity_version + 1 WHERE id=$1`, [args.patientId, args.deceasedAt, args.by ?? null]);
    await client.query(
      `INSERT INTO identity.patient_identity_history (id, patient_id, field, old_value, new_value, reason, changed_by)
       VALUES ($1,$2,'deceased','false',$3,$4,$5)`,
      [uuidv7(), args.patientId, args.deceasedAt, args.reason ?? null, args.by ?? null],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','patient',$3,$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by ?? null, args.patientId, `recorded deceased ${args.deceasedAt}${args.reason ? ' (' + args.reason + ')' : ''}`, 'deceased:' + args.patientId],
    );
    await client.query('COMMIT');
    return { patientId: args.patientId, deceasedAt: args.deceasedAt };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type IdentityHistoryEntry = { field: string; oldValue: string | null; newValue: string | null; reason: string | null; changedBy: string | null; changedAt: string };

/** The full identity change history for a patient, oldest first (provenance kept). */
export async function patientIdentityHistory(pool: Pool, patientId: string): Promise<IdentityHistoryEntry[]> {
  const r = await pool.query(
    `SELECT field, old_value, new_value, reason, changed_by, to_char(changed_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS changed_at
     FROM identity.patient_identity_history WHERE patient_id=$1 ORDER BY changed_at`,
    [patientId],
  );
  return r.rows.map((x) => ({ field: x.field, oldValue: x.old_value, newValue: x.new_value, reason: x.reason, changedBy: x.changed_by, changedAt: x.changed_at }));
}
