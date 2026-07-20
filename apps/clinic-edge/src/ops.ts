/**
 * Clinic operations: staff/credentials and tasks (OPS-001/003). An expired
 * credential can block configured clinical actions (OPS-001). Tasks carry an
 * owner, priority and due date; overdue open tasks surface on role dashboards for
 * escalation (OPS-003).
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class OpsError extends Error {}

export async function addStaff(pool: Pool, args: { fullName: string; role: string; registrationNo?: string; credentialExpiry?: string }): Promise<{ staffId: string }> {
  const staffId = uuidv7();
  await pool.query(
    `INSERT INTO organisation.staff (id, full_name, role, registration_no, credential_expiry) VALUES ($1,$2,$3,$4,$5)`,
    [staffId, args.fullName, args.role, args.registrationNo ?? null, args.credentialExpiry ?? null],
  );
  return { staffId };
}

export type CredentialCheck = { valid: boolean; reason?: 'expired' | 'inactive' | 'no_credential' };

/** Whether a staff member may perform a credentialed clinical action as of a date. */
export async function checkCredential(pool: Pool, staffId: string, asOf: string): Promise<CredentialCheck> {
  const r = await pool.query(`SELECT active, to_char(credential_expiry,'YYYY-MM-DD') AS exp FROM organisation.staff WHERE id=$1`, [staffId]);
  if (r.rows.length === 0) throw new OpsError('staff not found');
  if (!r.rows[0].active) return { valid: false, reason: 'inactive' };
  if (!r.rows[0].exp) return { valid: false, reason: 'no_credential' };
  if (r.rows[0].exp < asOf) return { valid: false, reason: 'expired' };
  return { valid: true };
}

export async function createTask(pool: Pool, args: { subject: string; owner?: string; priority?: number; dueDate?: string }): Promise<{ taskId: string }> {
  const taskId = uuidv7();
  await pool.query(`INSERT INTO flow.task (id, subject, owner, priority, due_date) VALUES ($1,$2,$3,$4,$5)`, [
    taskId,
    args.subject,
    args.owner ?? null,
    args.priority ?? 100,
    args.dueDate ?? null,
  ]);
  return { taskId };
}

export async function completeTask(pool: Pool, taskId: string): Promise<void> {
  const r = await pool.query(`UPDATE flow.task SET status='done', closed_at=now() WHERE id=$1 AND status='open'`, [taskId]);
  if (r.rowCount === 0) throw new OpsError('task not open');
}

/** Open tasks past their due date as of a date (OPS-003 escalation queue). */
export async function overdueTasks(pool: Pool, asOf: string): Promise<Array<{ taskId: string; subject: string; owner: string | null; priority: number; dueDate: string }>> {
  const r = await pool.query(
    `SELECT id, subject, owner, priority, to_char(due_date,'YYYY-MM-DD') AS due_date
     FROM flow.task WHERE status='open' AND due_date IS NOT NULL AND due_date < $1
     ORDER BY priority ASC, due_date ASC`,
    [asOf],
  );
  return r.rows.map((x) => ({ taskId: x.id, subject: x.subject, owner: x.owner, priority: x.priority, dueDate: x.due_date }));
}
