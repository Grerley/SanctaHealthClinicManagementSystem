/**
 * Cashier shift-close integration test (BIL-009, UAT-09) against real PostgreSQL.
 * Proves: a shift opens with a float; cash checkouts attach to it; a clean count
 * closes without approval; a count with variance above tolerance cannot close
 * without a supervisor and posts a cash-over/short journal; and a closed shift
 * cannot be closed again.
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
import { openShift, closeCashierShift, ShiftError } from '../src/cashier.ts';
import { CashierError } from '@sancta/domain';
import { doCheckout } from '../src/api.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const CASHIER = '00000000-0000-7000-8000-0000000000e1';
const PATIENT = '00000000-0000-7000-8000-000000000101';

async function reset(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await reset();
});
after(async () => {
  if (!skip && pool) await pool.end();
});

async function cashOverShortMinor(): Promise<number> {
  const r = await pool.query(
    `SELECT coalesce(sum(debit_minor)-sum(credit_minor),0)::int AS bal FROM finance.journal_line WHERE account_code='6900-CASH-OVER-SHORT'`,
  );
  return r.rows[0].bal as number;
}

test('a shift with an exact count closes without approval and posts no variance (UAT-09)', { skip }, async () => {
  await reset();
  const { shiftId } = await openShift(pool, { cashier: CASHIER, openingFloatMinor: 10000 });
  // Two cash payments of 300 each attach to the shift.
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 300, paymentMethod: 'cash', shiftId });
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 300, paymentMethod: 'cash', shiftId });

  // Expected = float 10000 + cash 600 = 10600. Count exactly that.
  const res = await closeCashierShift(pool, {
    shiftId,
    denominations: [{ unitMinor: 5000, count: 2 }, { unitMinor: 100, count: 6 }], // 10000 + 600 = 10600
    toleranceMinor: 100,
  });
  assert.equal(res.expectedMinor, 10600);
  assert.equal(res.countedMinor, 10600);
  assert.equal(res.varianceMinor, 0);
  assert.equal(res.requiresApproval, false);
  assert.equal(await cashOverShortMinor(), 0);
});

test('a mobile-money payment does NOT count toward the cash drawer', { skip }, async () => {
  await reset();
  const { shiftId } = await openShift(pool, { cashier: CASHIER, openingFloatMinor: 5000 });
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 400, paymentMethod: 'cash', shiftId });
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 999, paymentMethod: 'mobile', shiftId });
  // Expected cash = 5000 + 400 (cash only) = 5400.
  const res = await closeCashierShift(pool, { shiftId, denominations: [{ unitMinor: 100, count: 54 }], toleranceMinor: 50 });
  assert.equal(res.expectedMinor, 5400);
  assert.equal(res.varianceMinor, 0);
});

test('variance above tolerance cannot close without a supervisor, then posts cash-over/short (BIL-009)', { skip }, async () => {
  await reset();
  const { shiftId } = await openShift(pool, { cashier: CASHIER, openingFloatMinor: 10000 });
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 600, paymentMethod: 'cash', shiftId });
  // Expected = 10600. Count short by 500 (10100), tolerance 100.
  const short = [{ unitMinor: 5000, count: 2 }, { unitMinor: 100, count: 1 }]; // 10100

  await assert.rejects(closeCashierShift(pool, { shiftId, denominations: short, toleranceMinor: 100 }), CashierError);
  // Shift is still open after the rejected close.
  const stillOpen = await pool.query(`SELECT status FROM billing.cashier_shift WHERE id=$1`, [shiftId]);
  assert.equal(stillOpen.rows[0].status, 'open');

  // With a supervisor, it closes and posts the shortage journal.
  const res = await closeCashierShift(pool, { shiftId, denominations: short, toleranceMinor: 100, approver: '00000000-0000-7000-8000-0000000000aa' });
  assert.equal(res.varianceMinor, -500);
  assert.equal(res.approved, true);
  // Shortage: Dr cash over/short 500 / Cr cash 500.
  assert.equal(await cashOverShortMinor(), 500);
});

test('a closed shift cannot be closed again', { skip }, async () => {
  await reset();
  const { shiftId } = await openShift(pool, { cashier: CASHIER, openingFloatMinor: 1000 });
  await closeCashierShift(pool, { shiftId, denominations: [{ unitMinor: 100, count: 10 }], toleranceMinor: 0 });
  await assert.rejects(closeCashierShift(pool, { shiftId, denominations: [{ unitMinor: 100, count: 10 }], toleranceMinor: 0 }), ShiftError);
});
