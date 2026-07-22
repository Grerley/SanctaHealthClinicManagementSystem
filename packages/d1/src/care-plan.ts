/**
 * Care plans, goals & follow-ups on D1 (EHR-006). A plan groups goals and dated
 * follow-ups; overdue open follow-ups surface on a work queue so care continues
 * between visits, and completion is recorded with provenance. Ported from the
 * Postgres edge `care-plan.ts`.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class CarePlanError extends Error {}

export async function createCarePlan(db: D1Database, args: { patientId: string; title: string; encounterId?: string; user?: string }): Promise<{ id: string }> {
  if (!args.title?.trim()) throw new CarePlanError('a care plan needs a title');
  const id = uuidv7();
  await db.prepare(`INSERT INTO clinical_care_plan (id, patient_id, encounter_id, title, created_by) VALUES (?,?,?,?,?)`)
    .bind(id, args.patientId, args.encounterId ?? null, args.title, args.user ?? null).run();
  return { id };
}

export async function addGoal(db: D1Database, args: { carePlanId: string; description: string; targetDate?: string }): Promise<{ id: string }> {
  const plan = await one(db, `SELECT 1 AS ok FROM clinical_care_plan WHERE id=?`, [args.carePlanId]);
  if (!plan) throw new CarePlanError('care plan not found');
  const id = uuidv7();
  await db.prepare(`INSERT INTO clinical_care_goal (id, care_plan_id, description, target_date) VALUES (?,?,?,?)`)
    .bind(id, args.carePlanId, args.description, args.targetDate ?? null).run();
  return { id };
}

export async function addFollowUp(db: D1Database, args: { carePlanId: string; description: string; dueDate: string }): Promise<{ id: string }> {
  const plan = await one<{ patient_id: string }>(db, `SELECT patient_id FROM clinical_care_plan WHERE id=?`, [args.carePlanId]);
  if (!plan) throw new CarePlanError('care plan not found');
  if (!args.dueDate) throw new CarePlanError('a follow-up needs a due date');
  const id = uuidv7();
  await db.prepare(`INSERT INTO clinical_care_followup (id, care_plan_id, patient_id, description, due_date) VALUES (?,?,?,?,?)`)
    .bind(id, args.carePlanId, plan.patient_id, args.description, args.dueDate).run();
  return { id };
}

export async function completeFollowUp(db: D1Database, args: { id: string; user?: string }): Promise<{ id: string }> {
  const changed = await run(db, `UPDATE clinical_care_followup SET status='done', completed_by=?, completed_at=${NOW} WHERE id=? AND status='open'`, [args.user ?? null, args.id]);
  if (changed === 0) throw new CarePlanError('follow-up not found or already closed');
  return { id: args.id };
}

export type CarePlanView = {
  id: string; title: string; status: string;
  goals: Array<{ description: string; targetDate: string | null; status: string }>;
  followUps: Array<{ id: string; description: string; dueDate: string; status: string }>;
};

export async function listCarePlans(db: D1Database, patientId: string): Promise<CarePlanView[]> {
  const plans = await many<{ id: string; title: string; status: string }>(db, `SELECT id, title, status FROM clinical_care_plan WHERE patient_id=? ORDER BY created_at DESC`, [patientId]);
  const out: CarePlanView[] = [];
  for (const p of plans) {
    const goals = await many<{ description: string; target: string | null; status: string }>(db, `SELECT description, target_date AS target, status FROM clinical_care_goal WHERE care_plan_id=?`, [p.id]);
    const fups = await many<{ id: string; description: string; due: string; status: string }>(db, `SELECT id, description, due_date AS due, status FROM clinical_care_followup WHERE care_plan_id=? ORDER BY due_date`, [p.id]);
    out.push({
      id: p.id, title: p.title, status: p.status,
      goals: goals.map((g) => ({ description: g.description, targetDate: g.target, status: g.status })),
      followUps: fups.map((f) => ({ id: f.id, description: f.description, dueDate: f.due, status: f.status })),
    });
  }
  return out;
}

/** Overdue, still-open follow-ups — a care work queue (EHR-006). */
export async function overdueFollowUps(db: D1Database, asOf: string): Promise<Array<{ id: string; patientId: string; description: string; dueDate: string }>> {
  const rows = await many<{ id: string; patient_id: string; description: string; due: string }>(
    db, `SELECT id, patient_id, description, due_date AS due FROM clinical_care_followup WHERE status='open' AND due_date < ? ORDER BY due_date`, [asOf]);
  return rows.map((x) => ({ id: x.id, patientId: x.patient_id, description: x.description, dueDate: x.due }));
}
