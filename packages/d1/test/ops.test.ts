/**
 * Clinic operations on D1 (OPS-001/003/007). Runs on real SQLite. Proves: an
 * expired/absent credential is caught; tasks close once and overdue open tasks
 * surface for escalation; and staff productivity is counted from the audit trail.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, checkCredential, createTask, completeTask, overdueTasks, staffProductivity, OpsError } from '../src/ops.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('credential validity reflects expiry and active state', async () => {
  const { staffId } = await addStaff(db, { fullName: 'Dr Ada', role: 'clinical', credentialExpiry: '2026-12-31' });
  assert.equal((await checkCredential(db, staffId, '2026-07-01')).valid, true);
  assert.deepEqual(await checkCredential(db, staffId, '2027-01-01'), { valid: false, reason: 'expired' });
  const { staffId: noCred } = await addStaff(db, { fullName: 'Nurse Bo', role: 'clinical' });
  assert.deepEqual(await checkCredential(db, noCred, '2026-07-01'), { valid: false, reason: 'no_credential' });
  await assert.rejects(() => checkCredential(db, 'ghost', '2026-07-01'), OpsError);
});

test('tasks close once and overdue open tasks escalate', async () => {
  const { taskId } = await createTask(db, { subject: 'Restock trolley', owner: 'stock1', priority: 10, dueDate: '2026-07-01' });
  await createTask(db, { subject: 'Future task', dueDate: '2027-01-01' });
  const overdue = await overdueTasks(db, '2026-07-20');
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0]?.taskId, taskId);
  await completeTask(db, taskId);
  assert.equal((await overdueTasks(db, '2026-07-20')).length, 0);
  await assert.rejects(() => completeTask(db, taskId), OpsError); // already done
});

test('staff productivity is counted from the audit trail with an acuity signal', async () => {
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, outcome, captured_at) VALUES ('a1','dr1','sign','encounter','success','2026-07-10T09:00:00Z')`).run();
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, outcome, captured_at) VALUES ('a2','dr1','create','order','success','2026-07-10T10:00:00Z')`).run();
  await db.prepare(`INSERT INTO identity_patient (id, mrn) VALUES ('p1','MRN-OP1')`).run();
  await db.prepare(`INSERT INTO clinical_encounter (id, visit_id, patient_id, status) VALUES ('enc-op','v-op','p1','draft')`).run();
  await db.prepare(`INSERT INTO clinical_triage_assessment (id, encounter_id, patient_id, ews_band, created_by, created_at) VALUES ('t1','enc-op','p1','high','dr1','2026-07-10T08:00:00Z')`).run();
  const prod = await staffProductivity(db, { from: '2026-07-01', to: '2026-08-01' });
  assert.equal(prod.length, 1);
  assert.equal(prod[0]?.staffId, 'dr1');
  assert.equal(prod[0]?.total, 2);
  assert.equal(prod[0]?.highAcuityTriage, 1);
});
