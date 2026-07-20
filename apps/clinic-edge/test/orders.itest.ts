/**
 * Orders/results + critical-result acknowledgement (ORD-005/006, UAT-06) against
 * real PostgreSQL. Proves: an order is created and completed on result release; a
 * normal result needs no acknowledgement; a critical result appears on the
 * escalation queue until acknowledged, then leaves it; acknowledgement is
 * idempotent.
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
import { createOrder, releaseResult, acknowledgeCritical, outstandingCriticalResults } from '../src/orders.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const CLINICIAN = '00000000-0000-7000-8000-0000000000e1';

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

test('a normal result completes the order and needs no acknowledgement', { skip }, async () => {
  const { orderId } = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'GLUCOSE', indication: 'screening', requestedBy: CLINICIAN });
  const out = await releaseResult(pool, { orderId, value: 5.0, unit: 'mmol/L', refLow: 4, refHigh: 7.8, criticalLow: 2.2, criticalHigh: 25, verifiedBy: CLINICIAN });
  assert.equal(out.abnormal, 'normal');
  assert.equal(out.critical, false);
  const status = await pool.query(`SELECT status FROM clinical.service_request WHERE id=$1`, [orderId]);
  assert.equal(status.rows[0].status, 'completed');
  assert.equal((await outstandingCriticalResults(pool)).length, 0);
});

test('a critical result appears on the escalation queue until acknowledged (UAT-06)', { skip }, async () => {
  const { orderId } = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'GLUCOSE', requestedBy: CLINICIAN });
  const out = await releaseResult(pool, { orderId, value: 1.5, unit: 'mmol/L', refLow: 4, refHigh: 7.8, criticalLow: 2.2, criticalHigh: 25, verifiedBy: CLINICIAN });
  assert.equal(out.abnormal, 'low');
  assert.equal(out.critical, true);

  let queue = await outstandingCriticalResults(pool);
  assert.ok(queue.some((q) => q.resultId === out.resultId), 'critical result is on the queue');

  await acknowledgeCritical(pool, { resultId: out.resultId, acknowledgedBy: CLINICIAN, action: 'patient recalled, glucose given' });
  queue = await outstandingCriticalResults(pool);
  assert.ok(!queue.some((q) => q.resultId === out.resultId), 'acknowledged result leaves the queue');
});

test('acknowledgement is idempotent (a repeat does not create a second ack)', { skip }, async () => {
  const { orderId } = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'K', requestedBy: CLINICIAN });
  const out = await releaseResult(pool, { orderId, value: 30, unit: 'mmol/L', refLow: 3.5, refHigh: 5.1, criticalHigh: 6.5, verifiedBy: CLINICIAN });
  assert.equal(out.critical, true);
  await acknowledgeCritical(pool, { resultId: out.resultId, acknowledgedBy: CLINICIAN });
  await acknowledgeCritical(pool, { resultId: out.resultId, acknowledgedBy: CLINICIAN });
  const n = await pool.query(`SELECT count(*)::int AS n FROM clinical.critical_result_ack WHERE result_id=$1`, [out.resultId]);
  assert.equal(n.rows[0].n, 1);
});
