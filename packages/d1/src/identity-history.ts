/**
 * Patient identity history & deceased provenance on D1 (PAT-007, §6.1).
 *
 * A demographic change never silently overwrites: the previous value, new value
 * and provenance (who, when, why) are recorded in an immutable history, and the
 * patient's live value is updated with an incremented entity version. Death is
 * captured with a date and the recorder, not just a flag. Ported from the Postgres
 * edge `identity-history.ts`.
 *
 * D1 translations: interactive tx + FOR UPDATE → read current value then apply
 * update + history + audit in one db.batch; boolean deceased → INTEGER 0/1; the
 * field name is interpolated only from the MUTABLE_FIELDS whitelist (never input).
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class IdentityHistoryError extends Error {}

const MUTABLE_FIELDS = ['given_name', 'family_name', 'date_of_birth', 'sex', 'phone'] as const;
type MutableField = (typeof MUTABLE_FIELDS)[number];

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

/**
 * Change a demographic field, preserving the previous value with provenance.
 * Returns the recorded history entry id. Rejects an unknown field.
 */
export async function changeDemographic(
  db: D1Database,
  args: { patientId: string; field: MutableField; newValue: string | null; reason?: string; by?: string },
): Promise<{ historyId: string; field: string; oldValue: string | null; newValue: string | null }> {
  if (!(MUTABLE_FIELDS as readonly string[]).includes(args.field)) throw new IdentityHistoryError(`field ${args.field} is not an editable demographic`);
  const cur = await one<{ v: string | null }>(db, `SELECT ${args.field} AS v FROM identity_patient WHERE id=?`, [args.patientId]);
  if (!cur) throw new IdentityHistoryError(`patient ${args.patientId} not found`);
  const oldValue = cur.v ?? null;
  const historyId = uuidv7();
  await db.batch([
    stmt(db, `UPDATE identity_patient SET ${args.field}=?, entity_version = entity_version + 1, updated_at = ${NOW} WHERE id=?`, [args.newValue, args.patientId]),
    stmt(db, `INSERT INTO identity_patient_identity_history (id, patient_id, field, old_value, new_value, reason, changed_by) VALUES (?,?,?,?,?,?,?)`,
      [historyId, args.patientId, args.field, oldValue, args.newValue, args.reason ?? null, args.by ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,'amend','patient',?,?,'success',?,?)`,
      [uuidv7(), args.by ?? null, args.patientId, args.patientId, `${args.field}: "${oldValue ?? ''}" -> "${args.newValue ?? ''}"${args.reason ? ' (' + args.reason + ')' : ''}`, 'idhist:' + historyId]),
  ]);
  return { historyId, field: args.field, oldValue, newValue: args.newValue };
}

/** Record a patient's death with date + provenance (PAT-007). Guarded against re-recording. */
export async function markDeceased(
  db: D1Database,
  args: { patientId: string; deceasedAt: string; reason?: string; by?: string },
): Promise<{ patientId: string; deceasedAt: string }> {
  const cur = await one<{ deceased: number }>(db, `SELECT deceased FROM identity_patient WHERE id=?`, [args.patientId]);
  if (!cur) throw new IdentityHistoryError(`patient ${args.patientId} not found`);
  if (Number(cur.deceased) === 1) throw new IdentityHistoryError('patient is already recorded as deceased');
  await db.batch([
    stmt(db, `UPDATE identity_patient SET deceased=1, deceased_at=?, deceased_recorded_by=?, entity_version = entity_version + 1 WHERE id=?`, [args.deceasedAt, args.by ?? null, args.patientId]),
    stmt(db, `INSERT INTO identity_patient_identity_history (id, patient_id, field, old_value, new_value, reason, changed_by) VALUES (?,?,'deceased','false',?,?,?)`,
      [uuidv7(), args.patientId, args.deceasedAt, args.reason ?? null, args.by ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,'amend','patient',?,?,'success',?,?)`,
      [uuidv7(), args.by ?? null, args.patientId, args.patientId, `recorded deceased ${args.deceasedAt}${args.reason ? ' (' + args.reason + ')' : ''}`, 'deceased:' + args.patientId]),
  ]);
  return { patientId: args.patientId, deceasedAt: args.deceasedAt };
}

export type IdentityHistoryEntry = { field: string; oldValue: string | null; newValue: string | null; reason: string | null; changedBy: string | null; changedAt: string };

/** The full identity change history for a patient, oldest first (provenance kept). */
export async function patientIdentityHistory(db: D1Database, patientId: string): Promise<IdentityHistoryEntry[]> {
  const rows = await many<{ field: string; old_value: string | null; new_value: string | null; reason: string | null; changed_by: string | null; changed_at: string }>(db,
    `SELECT field, old_value, new_value, reason, changed_by, changed_at FROM identity_patient_identity_history WHERE patient_id=? ORDER BY changed_at`, [patientId]);
  return rows.map((x) => ({ field: x.field, oldValue: x.old_value, newValue: x.new_value, reason: x.reason, changedBy: x.changed_by, changedAt: x.changed_at }));
}
