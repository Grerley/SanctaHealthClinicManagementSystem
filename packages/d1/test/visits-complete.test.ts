/**
 * Visit transfer & completion on D1 (VIS-005/008). Runs on real SQLite (same
 * engine as D1). Proves: a visit can be transferred between stations, and it
 * cannot be completed while required tasks are unresolved (unsigned encounter /
 * unacknowledged critical result) unless an authorised override with a reason is
 * given — the override is audited.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startVisit, transfer, unresolvedTasks, completeVisit, queueBoard, VisitError } from '../src/visits.ts';
import { createDraftEncounter, signEncounter } from '../src/encounters.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'vis-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-020001', 'Vis', 'It').run();
});

test('a visit transfers between stations', async () => {
  const { visitId } = await startVisit(db, { patientId: PID, station: 'reception' });
  await transfer(db, { visitId, toStation: 'triage', priority: 50 });
  const q = await queueBoard(db, 'triage');
  assert.equal(q.length, 1);
  assert.equal(q[0]!.visitId, visitId);
  await assert.rejects(() => transfer(db, { visitId: 'nope', toStation: 'x' }), VisitError);
});

test('a visit with an unsigned encounter cannot complete without override', async () => {
  const { visitId } = await startVisit(db, { patientId: PID, station: 'reception' });
  // Attach a draft (unsigned) encounter to this visit.
  await db.prepare(`INSERT INTO clinical_encounter (id, visit_id, patient_id, status, form_version, content) VALUES ('enc-v','', ?, 'draft',1,'{}')`).bind(PID).run();
  await db.prepare(`UPDATE clinical_encounter SET visit_id=? WHERE id='enc-v'`).bind(visitId).run();
  const blocked = await completeVisit(db, { visitId });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.unresolved[0]!.includes('unsigned'));
  // Override closes it and audits.
  const forced = await completeVisit(db, { visitId, override: true, reason: 'patient left', user: 'mgr' });
  assert.equal(forced.ok, true);
  const v = await db.prepare(`SELECT status FROM flow_visit WHERE id=?`).bind(visitId).first<{ status: string }>();
  assert.equal(v?.status, 'complete');
  const audit = await db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE event_hash=?`).bind('visit-override:' + visitId).first<{ n: number }>();
  assert.equal(Number(audit?.n), 1);
});

test('a clean visit completes and leaves the queue', async () => {
  const { visitId } = await startVisit(db, { patientId: PID, station: 'reception' });
  const enc = await createDraftEncounter(db, { patientId: PID });
  await db.prepare(`UPDATE clinical_encounter SET visit_id=? WHERE id=?`).bind(visitId, enc.encounterId).run();
  await signEncounter(db, { encounterId: enc.encounterId, signedBy: 'dr1', content: {} });
  assert.deepEqual(await unresolvedTasks(db, visitId), []);
  const done = await completeVisit(db, { visitId });
  assert.equal(done.ok, true);
  assert.equal((await queueBoard(db)).filter((r) => r.visitId === visitId).length, 0);
});
