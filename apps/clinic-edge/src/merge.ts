/**
 * Reversible patient merge (PAT-008). Merges a duplicate into a surviving patient
 * WITHOUT deleting the source: all references are repointed to the survivor and
 * logged, and the merged row is preserved with merged_into set. Because every
 * moved record is logged, the merge can be reversed exactly by authorised support.
 * Never a silent/automatic merge — the caller confirms the pair first.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class MergeError extends Error {}

// Tables that carry a patient_id and are repointed on merge (all have a uuid `id`).
const PATIENT_TABLES = [
  'flow.visit',
  'clinical.encounter',
  'clinical.observation',
  'clinical.result',
  'clinical.service_request',
  'clinical.document_reference',
  'billing.invoice',
  'billing.payment',
  'scheduling.appointment',
  'flow.message',
];

export async function mergePatients(pool: Pool, args: { survivorId: string; mergedId: string; mergedBy: string }): Promise<{ mergeId: string; movedRecords: number }> {
  if (args.survivorId === args.mergedId) throw new MergeError('cannot merge a patient into itself');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const both = await client.query(`SELECT id, merged_into FROM identity.patient WHERE id = ANY($1)`, [[args.survivorId, args.mergedId]]);
    if (both.rows.length !== 2) throw new MergeError('both patients must exist');
    if (both.rows.some((r) => r.merged_into)) throw new MergeError('one of the patients is already merged');

    const mergeId = uuidv7();
    await client.query(`INSERT INTO identity.patient_merge (id, surviving_id, merged_id, merged_by, reversible) VALUES ($1,$2,$3,$4,true)`, [
      mergeId,
      args.survivorId,
      args.mergedId,
      args.mergedBy,
    ]);

    let moved = 0;
    for (const table of PATIENT_TABLES) {
      const rows = await client.query(`SELECT id FROM ${table} WHERE patient_id = $1`, [args.mergedId]);
      for (const r of rows.rows) {
        await client.query(`INSERT INTO identity.merge_moved_record (id, merge_id, table_name, record_id) VALUES ($1,$2,$3,$4)`, [uuidv7(), mergeId, table, r.id]);
      }
      const upd = await client.query(`UPDATE ${table} SET patient_id = $1 WHERE patient_id = $2`, [args.survivorId, args.mergedId]);
      moved += upd.rowCount ?? 0;
    }

    // Preserve the merged row; mark it merged (search excludes merged_into IS NOT NULL).
    await client.query(`UPDATE identity.patient SET merged_into = $1 WHERE id = $2`, [args.survivorId, args.mergedId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','patient_merge',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), args.mergedBy, mergeId, args.survivorId, `merged ${args.mergedId} into ${args.survivorId} (${moved} records)`, 'merge:' + mergeId],
    );

    await client.query('COMMIT');
    return { mergeId, movedRecords: moved };
  } catch (e) {
    if (e instanceof MergeError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Reverse a merge exactly, repointing the logged records back (PAT-008). */
export async function unmergePatients(pool: Pool, args: { mergeId: string; user: string }): Promise<{ restored: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const m = await client.query(`SELECT surviving_id, merged_id, reversible FROM identity.patient_merge WHERE id=$1 FOR UPDATE`, [args.mergeId]);
    if (m.rows.length === 0) throw new MergeError('merge not found');
    if (!m.rows[0].reversible) throw new MergeError('merge is not reversible');
    const mergedId = m.rows[0].merged_id as string;

    const moved = await client.query(`SELECT table_name, record_id FROM identity.merge_moved_record WHERE merge_id=$1`, [args.mergeId]);
    for (const r of moved.rows) {
      await client.query(`UPDATE ${r.table_name} SET patient_id = $1 WHERE id = $2`, [mergedId, r.record_id]);
    }
    await client.query(`UPDATE identity.patient SET merged_into = NULL WHERE id = $1`, [mergedId]);
    await client.query(`UPDATE identity.patient_merge SET reversible = false WHERE id = $1`, [args.mergeId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','patient_merge',$3,'success','merge reversed', now(), $4)`,
      [uuidv7(), args.user, args.mergeId, 'unmerge:' + args.mergeId],
    );
    await client.query('COMMIT');
    return { restored: moved.rows.length };
  } catch (e) {
    if (e instanceof MergeError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
