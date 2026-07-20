/**
 * Clinical handover & internal messages (EHR-012, pack §7.7). A message is
 * addressed to a staff member, optionally linked to a patient and/or a task, and
 * acknowledged by the recipient. The inbox surfaces unacknowledged items first so
 * handovers are not missed. Acknowledgement is recorded with provenance.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class HandoverError extends Error {}

export async function sendHandover(
  pool: Pool,
  args: { toStaff: string; message: string; fromStaff?: string; patientId?: string; taskId?: string },
): Promise<{ id: string }> {
  if (!args.toStaff) throw new HandoverError('a recipient (toStaff) is required');
  if (!args.message?.trim()) throw new HandoverError('a message is required');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO clinical.handover (id, from_staff, to_staff, patient_id, task_id, message) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, args.fromStaff ?? null, args.toStaff, args.patientId ?? null, args.taskId ?? null, args.message],
  );
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'create','handover',$3,$4,'success','handover sent', now(), $5)`,
    [uuidv7(), args.fromStaff ?? null, id, args.patientId ?? null, 'handover:' + id],
  );
  return { id };
}

export async function acknowledgeHandover(pool: Pool, args: { id: string; by: string }): Promise<{ id: string; status: 'acknowledged' }> {
  if (!args.by) throw new HandoverError('an acknowledger is required');
  const r = await pool.query(
    `UPDATE clinical.handover SET status='acknowledged', acknowledged_by=$2, acknowledged_at=now()
     WHERE id=$1 AND status='open' RETURNING id`,
    [args.id, args.by],
  );
  if (r.rowCount === 0) throw new HandoverError('handover not found or already acknowledged');
  return { id: args.id, status: 'acknowledged' };
}

export type InboxItem = { id: string; fromStaff: string | null; patientId: string | null; taskId: string | null; message: string; status: string; createdAt: string };

/** A staff member's inbox: unacknowledged first, newest within each group (EHR-012). */
export async function inbox(pool: Pool, staffId: string, includeAcknowledged = false): Promise<InboxItem[]> {
  const r = await pool.query(
    `SELECT id, from_staff, patient_id, task_id, message, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
     FROM clinical.handover
     WHERE to_staff=$1 AND ($2 OR status='open')
     ORDER BY (status='open') DESC, created_at DESC`,
    [staffId, includeAcknowledged],
  );
  return r.rows.map((x) => ({ id: x.id, fromStaff: x.from_staff, patientId: x.patient_id, taskId: x.task_id, message: x.message, status: x.status, createdAt: x.at }));
}
