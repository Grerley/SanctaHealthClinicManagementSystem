/**
 * Refunds as linked compensating transactions (BIL-010) against real PostgreSQL.
 * Proves: a refund requires an approver; it posts a reversing journal without
 * editing the original payment; over-refunding is refused; the payment row is
 * unchanged.
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
import { recordPayment, refundPayment, BillingError } from '../src/billing.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const APPROVER = '00000000-0000-7000-8000-0000000000aa';

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

test('a refund requires an approver and posts a reversing journal without editing the original (BIL-010)', { skip }, async () => {
  const { paymentId } = await recordPayment(pool, { patientId: PATIENT, method: 'cash', amountMinor: 500 });
  const paymentBefore = await pool.query(`SELECT amount_minor, status FROM billing.payment WHERE id=$1`, [paymentId]);

  await assert.rejects(refundPayment(pool, { paymentId, amountMinor: 200, method: 'cash', reason: 'overpayment' }), BillingError); // no approver

  const { refundId } = await refundPayment(pool, { paymentId, amountMinor: 200, method: 'cash', reason: 'overpayment', approver: APPROVER });
  assert.ok(refundId);

  // Original payment unchanged.
  const paymentAfter = await pool.query(`SELECT amount_minor, status FROM billing.payment WHERE id=$1`, [paymentId]);
  assert.equal(paymentAfter.rows[0].amount_minor, paymentBefore.rows[0].amount_minor);
  assert.equal(paymentAfter.rows[0].status, paymentBefore.rows[0].status);

  // A reversing refund journal exists (source_type = refund).
  const j = await pool.query(`SELECT count(*)::int AS n FROM finance.journal_batch WHERE source_type='refund'`);
  assert.equal(j.rows[0].n, 1);
});

test('over-refunding beyond the payment is refused', { skip }, async () => {
  const { paymentId } = await recordPayment(pool, { patientId: PATIENT, method: 'cash', amountMinor: 100 });
  await refundPayment(pool, { paymentId, amountMinor: 60, method: 'cash', reason: 'part refund', approver: APPROVER });
  // Only 40 remains refundable.
  await assert.rejects(refundPayment(pool, { paymentId, amountMinor: 60, method: 'cash', reason: 'again', approver: APPROVER }), BillingError);
});
