/**
 * Budgets & variance (FIN-007) against real PostgreSQL. Proves: a budget is set
 * per account+period (upserts); variance compares budget to the ACTUAL posted to
 * the ledger in that period, reconciling to the general ledger.
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
import { setBudget, budgetVariance, BudgetError } from '../src/finance-budget.ts';
import { draftManualJournal, approveManualJournal } from '../src/manual-journal.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const MAKER = '00000000-0000-7000-8000-0000000000a1';
const CHECKER = '00000000-0000-7000-8000-0000000000a2';
const MANAGER = '00000000-0000-7000-8000-0000000000c1';
const PERIOD = '2026-09';

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

test('a budget upserts per account + period (FIN-007)', { skip }, async () => {
  await setBudget(pool, { accountCode: '6000-OPERATING-EXPENSE', periodId: PERIOD, amountMinor: 100000, by: MANAGER });
  await setBudget(pool, { accountCode: '6000-OPERATING-EXPENSE', periodId: PERIOD, amountMinor: 120000, by: MANAGER }); // replace
  const r = await pool.query(`SELECT count(*)::int AS n, max(amount_minor) AS a FROM finance.budget WHERE account_code='6000-OPERATING-EXPENSE' AND period_id=$1`, [PERIOD]);
  assert.equal(r.rows[0].n, 1);
  assert.equal(Number(r.rows[0].a), 120000);
  await assert.rejects(setBudget(pool, { accountCode: 'NO-SUCH', periodId: PERIOD, amountMinor: 1, by: MANAGER }), BudgetError);
});

test('variance compares budget to the actual ledger postings (FIN-007)', { skip }, async () => {
  // Post 90,000 of operating expense in the period via a manual journal.
  const j = await draftManualJournal(pool, {
    memo: 'september rent',
    periodId: PERIOD,
    lines: [
      { accountCode: '6000-OPERATING-EXPENSE', debitMinor: 90000, creditMinor: 0 },
      { accountCode: '1000-CASH', debitMinor: 0, creditMinor: 90000 },
    ],
    maker: MAKER,
  });
  await approveManualJournal(pool, { journalId: j.journalId, checker: CHECKER });

  const v = await budgetVariance(pool, { periodId: PERIOD });
  const row = v.rows.find((x) => x.accountCode === '6000-OPERATING-EXPENSE')!;
  assert.equal(row.budgetMinor, 120000);
  assert.equal(row.actualMinor, 90000); // debit-positive net from the ledger
  assert.equal(row.varianceMinor, -30000); // under budget
  assert.equal(row.variancePct, -25); // -30000 / 120000
});
