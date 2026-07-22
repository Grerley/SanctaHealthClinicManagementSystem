/**
 * Visit escalation, event log & outcomes on D1 (VIS-004/006/007). Runs on real
 * SQLite. Proves: escalation requires a reason and raises visit + queue priority;
 * hold/resume follow the visit state machine; a terminal outcome needs a reason
 * and closes the queue entry; and durations are derived from the event/timestamps.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { escalateVisit, holdVisit, resumeVisit, endVisitWithOutcome, visitDurations, VisitLifecycleError } from '../src/visit-lifecycle.ts';
import { TransitionError } from '@sancta/domain';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'vl-p1';
const VID = 'vl-v1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn) VALUES (?,?)`).bind(PID, 'MRN-VL1').run();
  await db.prepare(`INSERT INTO flow_visit (id, patient_id, status, created_at) VALUES (?,?,'open','2026-07-20T08:00:00Z')`).bind(VID, PID).run();
  await db.prepare(`INSERT INTO flow_queue_entry (id, visit_id, token, station, priority) VALUES (?,?,?,?,?)`).bind('q1', VID, 1, 'triage', 100).run();
});

test('escalation requires a reason and raises visit + queue priority', async () => {
  await assert.rejects(() => escalateVisit(db, { visitId: VID, priority: 10, reason: '', by: 'nurse1' }), VisitLifecycleError);
  await escalateVisit(db, { visitId: VID, priority: 10, reason: 'chest pain', by: 'nurse1' });
  const v = await one<{ priority: number }>(db, `SELECT priority FROM flow_visit WHERE id=?`, [VID]);
  const q = await one<{ priority: number }>(db, `SELECT priority FROM flow_queue_entry WHERE visit_id=?`, [VID]);
  assert.equal(v?.priority, 10);
  assert.equal(q?.priority, 10);
});

test('hold then resume follows the visit state machine and stamps started_at', async () => {
  await holdVisit(db, { visitId: VID, reason: 'awaiting interpreter', by: 'nurse1' });
  assert.equal((await one<{ status: string }>(db, `SELECT status FROM flow_visit WHERE id=?`, [VID]))?.status, 'on_hold');
  await resumeVisit(db, { visitId: VID, to: 'in_care', by: 'dr1' });
  const v = await one<{ status: string; started_at: string | null }>(db, `SELECT status, started_at FROM flow_visit WHERE id=?`, [VID]);
  assert.equal(v?.status, 'in_care');
  assert.ok(v?.started_at, 'started_at should be stamped on entering care');
  // An illegal transition is refused (complete has no exits).
  await db.prepare(`UPDATE flow_visit SET status='complete' WHERE id=?`).bind(VID).run();
  await assert.rejects(() => holdVisit(db, { visitId: VID, reason: 'x', by: 'dr1' }), TransitionError);
});

test('a terminal outcome needs a reason, closes the queue, and durations derive', async () => {
  await assert.rejects(() => endVisitWithOutcome(db, { visitId: VID, outcome: 'refused', reason: '', by: 'nurse1' }), VisitLifecycleError);
  await assert.rejects(() => endVisitWithOutcome(db, { visitId: VID, outcome: 'nonsense', reason: 'x', by: 'nurse1' }), VisitLifecycleError);
  await endVisitWithOutcome(db, { visitId: VID, outcome: 'left_before_seen', reason: 'waited too long', by: 'nurse1' });
  const v = await one<{ status: string; outcome: string }>(db, `SELECT status, outcome FROM flow_visit WHERE id=?`, [VID]);
  assert.equal(v?.status, 'cancelled');
  assert.equal(v?.outcome, 'left_before_seen');
  assert.equal((await one<{ status: string }>(db, `SELECT status FROM flow_queue_entry WHERE visit_id=?`, [VID]))?.status, 'done');
  const d = await visitDurations(db, VID);
  assert.ok(d.totalMinutes !== null && d.totalMinutes >= 0);
  assert.ok(d.events.some((e) => e.event === 'left_before_seen'));
});
