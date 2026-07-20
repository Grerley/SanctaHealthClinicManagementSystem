/**
 * Expenses + accounts payable (FIN-005/006, UAT-12) against real PostgreSQL.
 * Proves: an approved expense posts Dr expense / Cr AP and creates a payable;
 * paying the supplier posts Dr AP / Cr cash and clears it; the AP subledger
 * reconciles to the GL control account throughout.
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
import { recordExpense, paySupplier, apReconciliation, PayableError } from '../src/payables.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
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

async function acct(code: string): Promise<number> {
  const r = await pool.query(`SELECT coalesce(sum(debit_minor)-sum(credit_minor),0)::int AS n FROM finance.journal_line WHERE account_code=$1`, [code]);
  return r.rows[0].n as number;
}

test('an expense requires an approver and posts Dr expense / Cr AP (FIN-005)', { skip }, async () => {
  await assert.rejects(recordExpense(pool, { category: 'rent', amountMinor: 5000 }), PayableError); // no approver
  const { payableId } = await recordExpense(pool, { category: 'rent', supplier: 'Landlord (SYNTHETIC)', amountMinor: 5000, approver: APPROVER });
  assert.ok(payableId);
  assert.equal(await acct('6000-OPERATING-EXPENSE'), 5000);
  assert.equal(await acct('2100-SUPPLIER-AP'), -5000); // credit
  const rec = await apReconciliation(pool);
  assert.equal(rec.subledgerMinor, 5000);
  assert.equal(rec.reconciles, true);
});

test('paying the supplier clears the payable and AP still reconciles (UAT-12)', { skip }, async () => {
  const { payableId } = await recordExpense(pool, { category: 'utilities', amountMinor: 3000, approver: APPROVER });
  let rec = await apReconciliation(pool);
  const openBefore = rec.subledgerMinor;
  const res = await paySupplier(pool, { payableId, method: 'cash' });
  assert.equal(res.paidMinor, 3000);

  rec = await apReconciliation(pool);
  assert.equal(rec.subledgerMinor, openBefore - 3000);
  assert.equal(rec.reconciles, true, 'AP subledger reconciles to the GL control');
  // Cash was credited by the payment.
  assert.equal(await acct('1000-CASH'), -3000);
});

test('a settled payable cannot be paid again', { skip }, async () => {
  const { payableId } = await recordExpense(pool, { category: 'stationery', amountMinor: 500, approver: APPROVER });
  await paySupplier(pool, { payableId });
  await assert.rejects(paySupplier(pool, { payableId }), PayableError);
});
