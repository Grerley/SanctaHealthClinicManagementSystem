/**
 * Clinical handover & internal messages on D1 (EHR-012, §7.7). A message is
 * addressed to a staff member, optionally linked to a patient and/or a task, and
 * acknowledged by the recipient. The inbox surfaces unacknowledged items first so
 * handovers are not missed. Acknowledgement is recorded with provenance. Ported
 * from the Postgres edge `handover.ts`.
 *
 * D1 translations: RETURNING-guarded UPDATE → run() rowcount as the acknowledge-
 * once gate; boolean includeAcknowledged folded into the WHERE.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many, run, stmt } from './query.ts';

export class HandoverError extends Error {}

export async function sendHandover(
  db: D1Database,
  args: { toStaff: string; message: string; fromStaff?: string; patientId?: string; taskId?: string },
): Promise<{ id: string }> {
  if (!args.toStaff) throw new HandoverError('a recipient (toStaff) is required');
  if (!args.message?.trim()) throw new HandoverError('a message is required');
  const id = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_handover (id, from_staff, to_staff, patient_id, task_id, message) VALUES (?,?,?,?,?,?)`,
      [id, args.fromStaff ?? null, args.toStaff, args.patientId ?? null, args.taskId ?? null, args.message]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,'create','handover',?,?,'success','handover sent',?)`,
      [uuidv7(), args.fromStaff ?? null, id, args.patientId ?? null, 'handover:' + id]),
  ]);
  return { id };
}

export async function acknowledgeHandover(db: D1Database, args: { id: string; by: string }): Promise<{ id: string; status: 'acknowledged' }> {
  if (!args.by) throw new HandoverError('an acknowledger is required');
  const changed = await run(db, `UPDATE clinical_handover SET status='acknowledged', acknowledged_by=?, acknowledged_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='open'`, [args.by, args.id]);
  if (changed === 0) throw new HandoverError('handover not found or already acknowledged');
  return { id: args.id, status: 'acknowledged' };
}

export type InboxItem = { id: string; fromStaff: string | null; patientId: string | null; taskId: string | null; message: string; status: string; createdAt: string };

/** A staff member's inbox: unacknowledged first, newest within each group (EHR-012). */
export async function inbox(db: D1Database, staffId: string, includeAcknowledged = false): Promise<InboxItem[]> {
  const rows = await many<{ id: string; from_staff: string | null; patient_id: string | null; task_id: string | null; message: string; status: string; at: string }>(
    db,
    `SELECT id, from_staff, patient_id, task_id, message, status, created_at AS at
     FROM clinical_handover
     WHERE to_staff=? AND (? OR status='open')
     ORDER BY (status='open') DESC, created_at DESC`,
    [staffId, includeAcknowledged ? 1 : 0],
  );
  return rows.map((x) => ({ id: x.id, fromStaff: x.from_staff, patientId: x.patient_id, taskId: x.task_id, message: x.message, status: x.status, createdAt: x.at }));
}
