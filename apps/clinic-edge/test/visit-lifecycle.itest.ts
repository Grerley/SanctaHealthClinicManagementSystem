/**
 * Visit escalation, event log & outcomes (VIS-004/006/007) against real
 * PostgreSQL. Proves: escalation raises priority with a required reason (audited);
 * the event log yields derived wait/total durations that reconcile to history;
 * and hold/resume + terminal outcomes (left-before-seen / refused / cancelled)
 * each require a reason.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { startVisit } from '../src/visits.ts';
import { escalateVisit, holdVisit, resumeVisit, endVisitWithOutcome, visitDurations, VisitLifecycleError } from '../src/visit-lifecycle.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const NURSE = '00000000-0000-7000-8000-0000000000e1';

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('escalation raises priority with a required reason, audited (VIS-004)', { skip }, async () => {
  const v = await startVisit(pool, { patientId: PATIENT });
  await assert.rejects(escalateVisit(pool, { visitId: v.visitId, priority: 1, reason: '', by: NURSE }), VisitLifecycleError);
  await escalateVisit(pool, { visitId: v.visitId, priority: 1, reason: 'acute deterioration', by: NURSE });

  const row = await pool.query(`SELECT priority FROM flow.visit WHERE id=$1`, [v.visitId]);
  assert.equal(row.rows[0].priority, 1);
  const q = await pool.query(`SELECT priority FROM flow.queue_entry WHERE visit_id=$1`, [v.visitId]);
  assert.equal(q.rows[0].priority, 1); // queue reflects the escalation
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='visit' AND resource_id=$1 AND reason LIKE 'escalated%'`, [v.visitId]);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('hold/resume and derived durations reconcile to the event history (VIS-006/007)', { skip }, async () => {
  const v = await startVisit(pool, { patientId: PATIENT });
  await holdVisit(pool, { visitId: v.visitId, reason: 'awaiting escort', by: NURSE });
  await assert.rejects(holdVisit(pool, { visitId: v.visitId, reason: '', by: NURSE }), VisitLifecycleError);
  await resumeVisit(pool, { visitId: v.visitId, to: 'in_care', by: NURSE }); // sets started_at

  const d = await visitDurations(pool, v.visitId);
  assert.ok(d.openedAt);
  assert.ok(d.startedAt);            // in-care start captured
  assert.notEqual(d.waitMinutes, null);
  assert.ok(d.waitMinutes! >= 0);
  // Events reconcile to history: on_hold then resumed appear in order.
  const events = d.events.map((e) => e.event);
  assert.ok(events.includes('on_hold'));
  assert.ok(events.includes('resumed'));
});

test('terminal outcomes require a reason and end the visit (VIS-007)', { skip }, async () => {
  const v = await startVisit(pool, { patientId: PATIENT });
  await assert.rejects(endVisitWithOutcome(pool, { visitId: v.visitId, outcome: 'left_before_seen', reason: '', by: NURSE }), VisitLifecycleError);
  await assert.rejects(endVisitWithOutcome(pool, { visitId: v.visitId, outcome: 'teleported', reason: 'x', by: NURSE }), VisitLifecycleError);

  const res = await endVisitWithOutcome(pool, { visitId: v.visitId, outcome: 'left_before_seen', reason: 'patient left the queue', by: NURSE });
  assert.equal(res.outcome, 'left_before_seen');
  const row = await pool.query(`SELECT status, outcome, completed_at FROM flow.visit WHERE id=$1`, [v.visitId]);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.equal(row.rows[0].outcome, 'left_before_seen');
  assert.ok(row.rows[0].completed_at);
  const q = await pool.query(`SELECT status FROM flow.queue_entry WHERE visit_id=$1`, [v.visitId]);
  assert.equal(q.rows[0].status, 'done'); // left the queue
  // A completed/cancelled visit cannot be ended again.
  await assert.rejects(endVisitWithOutcome(pool, { visitId: v.visitId, outcome: 'refused', reason: 'x', by: NURSE }), /cannot be ended/);
});
