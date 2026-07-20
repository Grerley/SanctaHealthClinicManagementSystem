/**
 * Care plans, goals & follow-ups (EHR-006, pack §7.5). A plan groups goals and
 * dated follow-ups; overdue follow-ups surface on a work queue so care continues
 * between visits. Follow-up completion is recorded with provenance.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class CarePlanError extends Error {}

export async function createCarePlan(pool: Pool, args: { patientId: string; title: string; encounterId?: string; user?: string }): Promise<{ id: string }> {
  if (!args.title?.trim()) throw new CarePlanError('a care plan needs a title');
  const id = uuidv7();
  await pool.query(`INSERT INTO clinical.care_plan (id, patient_id, encounter_id, title, created_by) VALUES ($1,$2,$3,$4,$5)`, [id, args.patientId, args.encounterId ?? null, args.title, args.user ?? null]);
  return { id };
}

export async function addGoal(pool: Pool, args: { carePlanId: string; description: string; targetDate?: string }): Promise<{ id: string }> {
  const plan = await pool.query(`SELECT 1 FROM clinical.care_plan WHERE id=$1`, [args.carePlanId]);
  if (plan.rowCount === 0) throw new CarePlanError('care plan not found');
  const id = uuidv7();
  await pool.query(`INSERT INTO clinical.care_goal (id, care_plan_id, description, target_date) VALUES ($1,$2,$3,$4)`, [id, args.carePlanId, args.description, args.targetDate ?? null]);
  return { id };
}

export async function addFollowUp(pool: Pool, args: { carePlanId: string; description: string; dueDate: string }): Promise<{ id: string }> {
  const plan = await pool.query(`SELECT patient_id FROM clinical.care_plan WHERE id=$1`, [args.carePlanId]);
  if (plan.rowCount === 0) throw new CarePlanError('care plan not found');
  if (!args.dueDate) throw new CarePlanError('a follow-up needs a due date');
  const id = uuidv7();
  await pool.query(`INSERT INTO clinical.care_followup (id, care_plan_id, patient_id, description, due_date) VALUES ($1,$2,$3,$4,$5)`, [id, args.carePlanId, plan.rows[0].patient_id, args.description, args.dueDate]);
  return { id };
}

export async function completeFollowUp(pool: Pool, args: { id: string; user?: string }): Promise<{ id: string }> {
  const r = await pool.query(`UPDATE clinical.care_followup SET status='done', completed_by=$2, completed_at=now() WHERE id=$1 AND status='open' RETURNING id`, [args.id, args.user ?? null]);
  if (r.rowCount === 0) throw new CarePlanError('follow-up not found or already closed');
  return { id: args.id };
}

export type CarePlanView = {
  id: string;
  title: string;
  status: string;
  goals: Array<{ description: string; targetDate: string | null; status: string }>;
  followUps: Array<{ id: string; description: string; dueDate: string; status: string }>;
};

export async function listCarePlans(pool: Pool, patientId: string): Promise<CarePlanView[]> {
  const plans = await pool.query(`SELECT id, title, status FROM clinical.care_plan WHERE patient_id=$1 ORDER BY created_at DESC`, [patientId]);
  const out: CarePlanView[] = [];
  for (const p of plans.rows) {
    const goals = await pool.query(`SELECT description, to_char(target_date,'YYYY-MM-DD') AS target, status FROM clinical.care_goal WHERE care_plan_id=$1`, [p.id]);
    const fups = await pool.query(`SELECT id, description, to_char(due_date,'YYYY-MM-DD') AS due, status FROM clinical.care_followup WHERE care_plan_id=$1 ORDER BY due_date`, [p.id]);
    out.push({
      id: p.id, title: p.title, status: p.status,
      goals: goals.rows.map((g) => ({ description: g.description, targetDate: g.target, status: g.status })),
      followUps: fups.rows.map((f) => ({ id: f.id, description: f.description, dueDate: f.due, status: f.status })),
    });
  }
  return out;
}

/** Overdue, still-open follow-ups — a care work queue (EHR-006). */
export async function overdueFollowUps(pool: Pool, asOf: string): Promise<Array<{ id: string; patientId: string; description: string; dueDate: string }>> {
  const r = await pool.query(
    `SELECT id, patient_id, description, to_char(due_date,'YYYY-MM-DD') AS due FROM clinical.care_followup
     WHERE status='open' AND due_date < $1 ORDER BY due_date`,
    [asOf],
  );
  return r.rows.map((x) => ({ id: x.id, patientId: x.patient_id, description: x.description, dueDate: x.due }));
}
