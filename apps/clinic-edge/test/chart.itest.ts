/**
 * Versioned chart of accounts, cost centres & dimensions (FIN-001) against real
 * PostgreSQL. Proves: an account definition is effective-dated (a revision adds a
 * version and resolves correctly by date without rewriting history); duplicate/
 * invalid codes are rejected; cost centres are governed and a posting with an
 * unknown/inactive cost centre is blocked at the choke point; dimensions are a
 * managed registry. Config changes are audited.
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
import { createCostCentre, listCostCentres, defineAccount, reviseAccount, accountAsOf, chartOfAccounts, createDimension, addDimensionValue, listDimensions, ChartAdminError } from '../src/chart.ts';
import { ChartError } from '@sancta/domain';
import { draftManualJournal, approveManualJournal } from '../src/manual-journal.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const ADMIN = '00000000-0000-7000-8000-0000000000c1';
const MAKER = '00000000-0000-7000-8000-0000000000a1';
const CHECKER = '00000000-0000-7000-8000-0000000000a2';

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

test('the seed chart is fully versioned (backfill to v1)', { skip }, async () => {
  const chart = await chartOfAccounts(pool, '2026-07-20');
  assert.ok(chart.length >= 10);
  const cash = chart.find((a) => a.code === '1000-CASH')!;
  assert.equal(cash.version, 1);
  assert.equal(cash.type, 'asset');
});

test('defining an account rejects duplicates and invalid codes/types (FIN-001)', { skip }, async () => {
  await defineAccount(pool, { code: '4200-GRANT-REVENUE', name: 'Grant revenue', type: 'revenue', effectiveFrom: '2026-01-01', by: ADMIN });
  await assert.rejects(defineAccount(pool, { code: '4200-GRANT-REVENUE', name: 'dup', type: 'revenue', effectiveFrom: '2026-01-01', by: ADMIN }), /already exists/);
  await assert.rejects(defineAccount(pool, { code: 'bad code', name: 'x', type: 'revenue', effectiveFrom: '2026-01-01', by: ADMIN }), ChartError);
  await assert.rejects(defineAccount(pool, { code: '4300-X', name: 'x', type: 'income', effectiveFrom: '2026-01-01', by: ADMIN }), ChartError);

  // The definition is audited as a config change.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE action='config' AND resource_type='account' AND reason LIKE '%4200-GRANT-REVENUE%'`);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('revising an account is effective-dated and resolves by date (FIN-001)', { skip }, async () => {
  await defineAccount(pool, { code: '6100-UTILITIES', name: 'Utilities', type: 'expense', effectiveFrom: '2026-01-01', by: ADMIN });
  // Rename effective 1 August; history before that keeps the old name.
  const rev = await reviseAccount(pool, { code: '6100-UTILITIES', name: 'Utilities & power', effectiveFrom: '2026-08-01', by: ADMIN });
  assert.equal(rev.version, 2);

  assert.equal((await accountAsOf(pool, '6100-UTILITIES', '2026-05-01')).name, 'Utilities');
  assert.equal((await accountAsOf(pool, '6100-UTILITIES', '2026-08-01')).name, 'Utilities & power');

  // A revision must move forward in time.
  await assert.rejects(reviseAccount(pool, { code: '6100-UTILITIES', name: 'x', effectiveFrom: '2026-08-01', by: ADMIN }), /must be after/);

  // Deactivating removes it from the as-of chart.
  await reviseAccount(pool, { code: '6100-UTILITIES', active: false, effectiveFrom: '2026-09-01', by: ADMIN });
  const chartSep = await chartOfAccounts(pool, '2026-09-15');
  assert.ok(!chartSep.some((a) => a.code === '6100-UTILITIES'));
});

test('cost centres are governed; posting with an unknown one is blocked (FIN-001)', { skip }, async () => {
  const centres = await listCostCentres(pool);
  assert.ok(centres.some((c) => c.code === 'GEN')); // seeded default
  await createCostCentre(pool, { code: 'OPD', name: 'Outpatient department', by: ADMIN });

  // A manual journal tagged with an unknown cost centre is rejected at posting.
  const bad = await draftManualJournal(pool, {
    memo: 'mis-tagged',
    periodId: '2026-09',
    lines: [
      { accountCode: '6000-OPERATING-EXPENSE', debitMinor: 100, creditMinor: 0, costCentre: 'NOPE' },
      { accountCode: '1000-CASH', debitMinor: 0, creditMinor: 100 },
    ],
    maker: MAKER,
  });
  await assert.rejects(approveManualJournal(pool, { journalId: bad.journalId, checker: CHECKER }), /cost centre/);

  // The same journal against a known active cost centre posts cleanly.
  const good = await draftManualJournal(pool, {
    memo: 'OPD supplies',
    periodId: '2026-09',
    lines: [
      { accountCode: '6000-OPERATING-EXPENSE', debitMinor: 100, creditMinor: 0, costCentre: 'OPD' },
      { accountCode: '1000-CASH', debitMinor: 0, creditMinor: 100 },
    ],
    maker: MAKER,
  });
  const res = await approveManualJournal(pool, { journalId: good.journalId, checker: CHECKER });
  assert.equal(res.status, 'posted');
  const line = await pool.query(`SELECT cost_centre FROM finance.journal_line WHERE batch_id=$1 AND cost_centre IS NOT NULL`, [res.batchId]);
  assert.equal(line.rows[0].cost_centre, 'OPD');
});

test('dimensions are a managed registry (FIN-001)', { skip }, async () => {
  await createDimension(pool, { code: 'PROGRAMME', name: 'Programme', by: ADMIN });
  await addDimensionValue(pool, { dimensionCode: 'PROGRAMME', valueCode: 'MCH', label: 'Maternal & child health', by: ADMIN });
  await addDimensionValue(pool, { dimensionCode: 'PROGRAMME', valueCode: 'HIV', label: 'HIV care', by: ADMIN });
  await assert.rejects(addDimensionValue(pool, { dimensionCode: 'NOPE', valueCode: 'X', label: 'x', by: ADMIN }), /unknown dimension/);

  const dims = await listDimensions(pool);
  const prog = dims.find((d) => d.code === 'PROGRAMME')!;
  assert.equal(prog.values.length, 2);
  assert.ok(prog.values.some((v) => v.valueCode === 'MCH'));
});
