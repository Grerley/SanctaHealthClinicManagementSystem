/**
 * Care plans, goals & follow-ups on D1 (EHR-006). Runs on real SQLite (same engine
 * as D1). Proves the between-visits continuity: overdue open follow-ups surface on
 * the work queue and drop off once completed (with provenance).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCarePlan, addGoal, addFollowUp, completeFollowUp, listCarePlans, overdueFollowUps, CarePlanError } from '../src/care-plan.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'cp-pat-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-500001', 'Care', 'Test').run();
});

test('a plan needs a title', async () => {
  await assert.rejects(() => createCarePlan(db, { patientId: PID, title: '  ' }), CarePlanError);
});

test('a plan holds goals and follow-ups, readable together', async () => {
  const { id } = await createCarePlan(db, { patientId: PID, title: 'Hypertension' });
  await addGoal(db, { carePlanId: id, description: 'BP < 140/90', targetDate: '2026-09-01' });
  await addFollowUp(db, { carePlanId: id, description: 'BP recheck', dueDate: '2026-08-01' });
  const [plan] = await listCarePlans(db, PID);
  assert.equal(plan!.title, 'Hypertension');
  assert.equal(plan!.goals.length, 1);
  assert.equal(plan!.followUps.length, 1);
});

test('overdue open follow-ups surface, then drop off when completed', async () => {
  const { id } = await createCarePlan(db, { patientId: PID, title: 'Diabetes' });
  const fu = await addFollowUp(db, { carePlanId: id, description: 'HbA1c', dueDate: '2026-07-01' });
  const overdue = await overdueFollowUps(db, '2026-07-22');
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0]!.id, fu.id);
  await completeFollowUp(db, { id: fu.id, user: 'nurse1' });
  assert.equal((await overdueFollowUps(db, '2026-07-22')).length, 0);
  // Completing again is rejected.
  await assert.rejects(() => completeFollowUp(db, { id: fu.id }), CarePlanError);
});

test('a follow-up not yet due is not overdue', async () => {
  const { id } = await createCarePlan(db, { patientId: PID, title: 'Asthma' });
  await addFollowUp(db, { carePlanId: id, description: 'Review inhaler', dueDate: '2026-12-01' });
  assert.equal((await overdueFollowUps(db, '2026-07-22')).length, 0);
});
