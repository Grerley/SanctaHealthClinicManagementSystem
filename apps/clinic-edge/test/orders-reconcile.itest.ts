/**
 * External-result reconciliation (ORD-007) + cancel/correct without deleting
 * (ORD-009) against real PostgreSQL. Proves: an external result auto-matches an
 * order or queues as unmatched then reconciles; an order cancels with a reason
 * (retained, audited); and a result correction retains the original (append-only)
 * and supersedes it.
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
import { createOrder, releaseResult, attachExternalResult, reconcileExternalResult, unmatchedResults, cancelOrder, correctResult, OrderError } from '../src/orders.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const LAB = '00000000-0000-7000-8000-0000000000e1';

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

test('an external result auto-matches an order, else queues then reconciles (ORD-007)', { skip }, async () => {
  const order = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'FBC', requestedBy: LAB });

  // Matches by code.
  const matched = await attachExternalResult(pool, { orderRef: 'FBC', patientId: PATIENT, value: 5.2, unit: '10^9/L', source: 'ExternalLab' });
  assert.equal(matched.matched, true);
  assert.equal(matched.serviceRequestId, order.orderId);

  // No matching order → unmatched queue.
  const orphan = await attachExternalResult(pool, { orderRef: 'UNKNOWN-REF', value: 9, source: 'ExternalLab' });
  assert.equal(orphan.matched, false);
  assert.ok((await unmatchedResults(pool)).some((u) => u.id === orphan.id));

  // Reconcile the orphan to the order.
  const rec = await reconcileExternalResult(pool, { externalResultId: orphan.id, serviceRequestId: order.orderId, by: LAB });
  assert.equal(rec.status, 'matched');
  assert.ok(!(await unmatchedResults(pool)).some((u) => u.id === orphan.id));
  await assert.rejects(reconcileExternalResult(pool, { externalResultId: orphan.id, serviceRequestId: order.orderId, by: LAB }), /already matched/);
});

test('an order cancels with a required reason and is retained + audited (ORD-009)', { skip }, async () => {
  const order = await createOrder(pool, { patientId: PATIENT, category: 'imaging', code: 'CXR', requestedBy: LAB });
  await assert.rejects(cancelOrder(pool, { orderId: order.orderId, reason: '', by: LAB }), OrderError);
  await cancelOrder(pool, { orderId: order.orderId, reason: 'ordered in error', by: LAB });

  const row = await pool.query(`SELECT status FROM clinical.service_request WHERE id=$1`, [order.orderId]);
  assert.equal(row.rows[0].status, 'cancelled'); // retained, not deleted
  const audit = await pool.query(`SELECT reason FROM audit.audit_event WHERE resource_type='service_request' AND resource_id=$1 AND reason LIKE 'cancelled:%'`, [order.orderId]);
  assert.ok((audit.rowCount ?? 0) >= 1);
  await assert.rejects(cancelOrder(pool, { orderId: order.orderId, reason: 'again', by: LAB }), /cancelled order cannot be cancelled/);
});

test('a result correction retains the original and supersedes it (ORD-009)', { skip }, async () => {
  const order = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'GLU', requestedBy: LAB });
  const orig = await releaseResult(pool, { orderId: order.orderId, value: 3.2, unit: 'mmol/L', verifiedBy: LAB });

  await assert.rejects(correctResult(pool, { resultId: orig.resultId, newValue: 6.5, reason: '', by: LAB }), OrderError);
  const corrected = await correctResult(pool, { resultId: orig.resultId, newValue: 6.5, reason: 'transcription error', by: LAB });

  // Original is retained and marked corrected; the new result supersedes it.
  const rows = await pool.query(`SELECT id, value, status, supersedes FROM clinical.result WHERE service_request_id=$1 ORDER BY released_at`, [order.orderId]);
  assert.equal(rows.rowCount, 2); // original + correction, nothing deleted
  const original = rows.rows.find((r) => r.id === orig.resultId)!;
  const newer = rows.rows.find((r) => r.id === corrected.correctedResultId)!;
  assert.equal(original.status, 'corrected');
  assert.equal(Number(original.value), 3.2); // original value preserved
  assert.equal(Number(newer.value), 6.5);
  assert.equal(newer.supersedes, orig.resultId);
  await assert.rejects(correctResult(pool, { resultId: orig.resultId, newValue: 7, reason: 'x', by: LAB }), /already corrected/);
});
