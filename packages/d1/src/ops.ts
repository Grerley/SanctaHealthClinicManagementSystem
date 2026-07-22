/**
 * Clinic operations: staff/credentials and tasks on D1 (OPS-001/003/007). An
 * expired credential can block configured clinical actions (OPS-001). Tasks carry
 * an owner, priority and due date; overdue open tasks surface for escalation
 * (OPS-003). Staff productivity is counted from the audit trail with a complexity
 * signal (OPS-007). Ported from the Postgres edge `ops.ts`.
 *
 * D1 translations: boolean active → INTEGER 0/1; to_char → stored ISO text sliced;
 * count/group aggregates unchanged; guarded task-close UPDATE.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run } from './query.ts';

export class OpsError extends Error {}

export async function addStaff(db: D1Database, args: { fullName: string; role: string; registrationNo?: string; credentialExpiry?: string }): Promise<{ staffId: string }> {
  const staffId = uuidv7();
  await db.prepare(`INSERT INTO organisation_staff (id, full_name, role, registration_no, credential_expiry) VALUES (?,?,?,?,?)`)
    .bind(staffId, args.fullName, args.role, args.registrationNo ?? null, args.credentialExpiry ?? null).run();
  return { staffId };
}

export type CredentialCheck = { valid: boolean; reason?: 'expired' | 'inactive' | 'no_credential' };

/** Whether a staff member may perform a credentialed clinical action as of a date. */
export async function checkCredential(db: D1Database, staffId: string, asOf: string): Promise<CredentialCheck> {
  const r = await one<{ active: number; exp: string | null }>(db, `SELECT active, credential_expiry AS exp FROM organisation_staff WHERE id=?`, [staffId]);
  if (!r) throw new OpsError('staff not found');
  if (Number(r.active) === 0) return { valid: false, reason: 'inactive' };
  if (!r.exp) return { valid: false, reason: 'no_credential' };
  if (String(r.exp).slice(0, 10) < asOf) return { valid: false, reason: 'expired' };
  return { valid: true };
}

export async function createTask(db: D1Database, args: { subject: string; owner?: string; priority?: number; dueDate?: string }): Promise<{ taskId: string }> {
  const taskId = uuidv7();
  await db.prepare(`INSERT INTO flow_task (id, subject, owner, priority, due_date) VALUES (?,?,?,?,?)`)
    .bind(taskId, args.subject, args.owner ?? null, args.priority ?? 100, args.dueDate ?? null).run();
  return { taskId };
}

export async function completeTask(db: D1Database, taskId: string): Promise<void> {
  const changed = await run(db, `UPDATE flow_task SET status='done', closed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='open'`, [taskId]);
  if (changed === 0) throw new OpsError('task not open');
}

/** Open tasks past their due date as of a date (OPS-003 escalation queue). */
export async function overdueTasks(db: D1Database, asOf: string): Promise<Array<{ taskId: string; subject: string; owner: string | null; priority: number; dueDate: string }>> {
  const rows = await many<{ id: string; subject: string; owner: string | null; priority: number; due_date: string }>(db,
    `SELECT id, subject, owner, priority, due_date FROM flow_task WHERE status='open' AND due_date IS NOT NULL AND due_date < ? ORDER BY priority ASC, due_date ASC`, [asOf]);
  return rows.map((x) => ({ taskId: x.id, subject: x.subject, owner: x.owner, priority: Number(x.priority), dueDate: x.due_date }));
}

export type StaffProductivity = { staffId: string; actions: Record<string, number>; total: number; highAcuityTriage: number };

/**
 * Staff activity/productivity over a period with quality/complexity context
 * (OPS-007). Activity is counted from the audit trail so the figures reconcile to
 * what actually happened; the complexity signal is the number of high-acuity
 * (high EWS) triage assessments handled. Productivity is context, never a
 * stand-alone performance verdict.
 */
export async function staffProductivity(db: D1Database, args: { from: string; to: string }): Promise<StaffProductivity[]> {
  const acts = await many<{ actor_user: string; action: string; n: number }>(db,
    `SELECT actor_user, action, COUNT(*) AS n FROM audit_event WHERE actor_user IS NOT NULL AND captured_at >= ? AND captured_at < ? GROUP BY actor_user, action`, [args.from, args.to]);
  const acuity = await many<{ created_by: string; n: number }>(db,
    `SELECT created_by, COUNT(*) AS n FROM clinical_triage_assessment WHERE ews_band='high' AND created_by IS NOT NULL AND created_at >= ? AND created_at < ? GROUP BY created_by`, [args.from, args.to]);
  const byStaff = new Map<string, StaffProductivity>();
  const get = (id: string): StaffProductivity => {
    let s = byStaff.get(id);
    if (!s) { s = { staffId: id, actions: {}, total: 0, highAcuityTriage: 0 }; byStaff.set(id, s); }
    return s;
  };
  for (const r of acts) {
    const s = get(r.actor_user);
    s.actions[r.action] = (s.actions[r.action] ?? 0) + Number(r.n);
    s.total += Number(r.n);
  }
  for (const r of acuity) get(r.created_by).highAcuityTriage = Number(r.n);
  return [...byStaff.values()].sort((a, b) => b.total - a.total);
}
