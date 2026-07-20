/**
 * Visit flow: queue, transfer and completion validation (VIS-003/005/008) against
 * real PostgreSQL. Proves: starting a visit issues a token and puts it on the
 * queue board; transfer moves it between stations; a visit with an unacknowledged
 * critical result cannot complete without an override; override closes it and is
 * audited.
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
import { startVisit, transfer, queueBoard, completeVisit, unresolvedTasks } from '../src/visits.ts';
import { createOrder, releaseResult, acknowledgeCritical } from '../src/orders.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';

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

test('starting a visit issues a token and shows it on the queue board (VIS-003)', { skip }, async () => {
  const v = await startVisit(pool, { patientId: PATIENT, station: 'reception' });
  assert.ok(v.token >= 1);
  const board = await queueBoard(pool, 'reception');
  assert.ok(board.some((r) => r.visitId === v.visitId && r.token === v.token));
});

test('transfer moves the visit to another station (VIS-005)', { skip }, async () => {
  const v = await startVisit(pool, { patientId: PATIENT, station: 'reception' });
  await transfer(pool, { visitId: v.visitId, toStation: 'triage' });
  const reception = await queueBoard(pool, 'reception');
  const triage = await queueBoard(pool, 'triage');
  assert.ok(!reception.some((r) => r.visitId === v.visitId));
  assert.ok(triage.some((r) => r.visitId === v.visitId));
});

test('a visit with an unacknowledged critical result cannot complete without override (VIS-008)', { skip }, async () => {
  const v = await startVisit(pool, { patientId: PATIENT, station: 'clinician' });
  const { orderId } = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'GLUCOSE' });
  const r = await releaseResult(pool, { orderId, value: 1.4, refLow: 4, refHigh: 7.8, criticalLow: 2.2 });

  const blocked = await completeVisit(pool, { visitId: v.visitId });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.unresolved.some((u) => /critical/.test(u)));

  // Acknowledge -> now it completes cleanly.
  await acknowledgeCritical(pool, { resultId: r.resultId, acknowledgedBy: PATIENT });
  assert.equal((await unresolvedTasks(pool, v.visitId)).length, 0);
  const ok = await completeVisit(pool, { visitId: v.visitId });
  assert.equal(ok.ok, true);
});

test('an authorised override closes a visit with unresolved tasks and is audited (VIS-008)', { skip }, async () => {
  const v = await startVisit(pool, { patientId: PATIENT, station: 'clinician' });
  const { orderId } = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'K' });
  await releaseResult(pool, { orderId, value: 30, refHigh: 5.1, criticalHigh: 6.5 });

  const res = await completeVisit(pool, { visitId: v.visitId, override: true, reason: 'patient left; followed up by phone', user: PATIENT });
  assert.equal(res.ok, true);
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='visit' AND resource_id=$1`, [v.visitId]);
  assert.ok((audit.rows[0].n as number) >= 1);
});
