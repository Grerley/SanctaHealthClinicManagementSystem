/**
 * Reversible patient merge on D1 (PAT-008). Merges a duplicate into a survivor
 * WITHOUT deleting the source: every patient-referencing record is repointed to
 * the survivor and logged, and the merged row is kept with merged_into set. Because
 * each moved record is logged, the merge reverses exactly. Never automatic — the
 * caller confirms the pair first. Ported from the Postgres edge `merge.ts`.
 *
 * D1 translations: FOR UPDATE + interactive tx → read the record ids first, then
 * commit the repoint + log + mark as one atomic db.batch(). The repointed tables
 * are the D1 tables that carry patient_id and currently exist.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class MergeError extends Error {}

// D1 tables that carry patient_id and are repointed on merge (each has a TEXT id).
const PATIENT_TABLES = [
  'flow_visit', 'clinical_encounter', 'clinical_observation', 'clinical_result',
  'clinical_service_request', 'billing_invoice', 'billing_payment', 'scheduling_appointment',
];

export async function mergePatients(db: D1Database, args: { survivorId: string; mergedId: string; mergedBy: string }): Promise<{ mergeId: string; movedRecords: number }> {
  if (args.survivorId === args.mergedId) throw new MergeError('cannot merge a patient into itself');
  const both = await many<{ id: string; merged_into: string | null }>(db, `SELECT id, merged_into FROM identity_patient WHERE id IN (?,?)`, [args.survivorId, args.mergedId]);
  if (both.length !== 2) throw new MergeError('both patients must exist');
  if (both.some((r) => r.merged_into)) throw new MergeError('one of the patients is already merged');

  const mergeId = uuidv7();
  const statements = [stmt(db, `INSERT INTO identity_patient_merge (id, surviving_id, merged_id, merged_by, reversible) VALUES (?,?,?,?,1)`, [mergeId, args.survivorId, args.mergedId, args.mergedBy])];
  let moved = 0;
  for (const table of PATIENT_TABLES) {
    const rows = await many<{ id: string }>(db, `SELECT id FROM ${table} WHERE patient_id = ?`, [args.mergedId]);
    for (const r of rows) statements.push(stmt(db, `INSERT INTO identity_merge_moved_record (id, merge_id, table_name, record_id) VALUES (?,?,?,?)`, [uuidv7(), mergeId, table, r.id]));
    statements.push(stmt(db, `UPDATE ${table} SET patient_id = ? WHERE patient_id = ?`, [args.survivorId, args.mergedId]));
    moved += rows.length;
  }
  statements.push(stmt(db, `UPDATE identity_patient SET merged_into = ? WHERE id = ?`, [args.survivorId, args.mergedId]));
  statements.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,'amend','patient_merge',?,?,'success',?,?)`,
    [uuidv7(), args.mergedBy, mergeId, args.survivorId, `merged ${args.mergedId} into ${args.survivorId} (${moved} records)`, 'merge:' + mergeId]));
  await db.batch(statements);
  return { mergeId, movedRecords: moved };
}

/** Reverse a merge exactly, repointing the logged records back (PAT-008). */
export async function unmergePatients(db: D1Database, args: { mergeId: string; user: string }): Promise<{ restored: number }> {
  const m = await one<{ surviving_id: string; merged_id: string; reversible: number }>(db, `SELECT surviving_id, merged_id, reversible FROM identity_patient_merge WHERE id=?`, [args.mergeId]);
  if (!m) throw new MergeError('merge not found');
  if (!m.reversible) throw new MergeError('merge is not reversible');
  const moved = await many<{ table_name: string; record_id: string }>(db, `SELECT table_name, record_id FROM identity_merge_moved_record WHERE merge_id=?`, [args.mergeId]);
  const statements = moved.map((r) => stmt(db, `UPDATE ${r.table_name} SET patient_id = ? WHERE id = ?`, [m.merged_id, r.record_id]));
  statements.push(stmt(db, `UPDATE identity_patient SET merged_into = NULL WHERE id = ?`, [m.merged_id]));
  statements.push(stmt(db, `UPDATE identity_patient_merge SET reversible = 0 WHERE id = ?`, [args.mergeId]));
  statements.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','patient_merge',?,'success','merge reversed',?)`,
    [uuidv7(), args.user, args.mergeId, 'unmerge:' + args.mergeId]));
  await db.batch(statements);
  return { restored: moved.length };
}
