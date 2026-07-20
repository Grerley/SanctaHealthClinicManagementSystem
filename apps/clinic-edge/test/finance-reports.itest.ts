/**
 * Financial statements (FIN-010) against real PostgreSQL. Proves: the trial
 * balance always nets to zero (Σ debits = Σ credits); the income statement is
 * built from the same postings and its revenue/expense figures match the ledger;
 * dispensing recognises COGS so gross margin is visible.
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
import { doCheckout } from '../src/api.ts';
import { trialBalance, incomeStatement } from '../src/finance-reports.ts';

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
  // A medicine dispense recognises revenue AND COGS.
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 1500, paymentMinor: 1500, paymentMethod: 'cash' });
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('the trial balance always nets to zero (FIN-010)', { skip }, async () => {
  const tb = await trialBalance(pool);
  assert.equal(tb.totalDebitMinor, tb.totalCreditMinor);
  assert.equal(tb.balanced, true);
  assert.ok(tb.rows.length > 0);
});

test('the income statement matches the ledger and shows revenue and COGS', { skip }, async () => {
  const is = await incomeStatement(pool);
  // Medicine revenue 1500 was recognised.
  assert.equal(is.revenueMinor, 1500);
  // COGS = 10 units from FEFO lot L2 @12 = 120.
  const cogs = is.expenseLines.find((l) => l.code === '5000-COGS');
  assert.equal(cogs?.amountMinor, 120);
  assert.equal(is.netResultMinor, is.revenueMinor - is.expensesMinor);
  assert.equal(is.reconcilesToTrialBalance, true);
});
