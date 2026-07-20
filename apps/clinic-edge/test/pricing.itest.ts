/**
 * Effective-dated pricing & priced service charges (BIL-001, BIL-003, BR-005)
 * against real PostgreSQL. Proves: a quote resolves the fee version in force on
 * the date (including a mid-year price change with tax); overrides obey the
 * reason/approver rules; charging a service creates an invoice that retains the
 * applied pricing, and the finalisation journal balances with tax split to a
 * liability; the fee schedule can be revised forward-dated.
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
import { PriceError } from '@sancta/domain';
import { quotePrice, chargeService, defineFee, listFees, PricingError } from '../src/pricing.ts';
import { invoiceOutstanding } from '../src/billing.ts';
import { trialBalance } from '../src/finance-reports.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const FINANCE = '00000000-0000-7000-8000-0000000000ad';
const ADMIN = '00000000-0000-7000-8000-0000000000c1';

async function accountCredit(code: string): Promise<number> {
  const tb = await trialBalance(pool);
  const row = tb.rows.find((r) => r.code === code);
  return row ? -row.netMinor : 0; // credit-positive
}

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

test('a quote resolves the fee version in force on the date (BIL-001)', { skip }, async () => {
  // v1 (Jan–Jul): 1000, no tax.
  const june = await quotePrice(pool, { serviceCode: 'CONSULT-GP', onDate: '2026-06-15' });
  assert.equal(june.ruleVersion, 1);
  assert.equal(june.applied.minor, 1000);
  assert.equal(june.tax.minor, 0);
  assert.equal(june.total.minor, 1000);

  // v2 (from Jul): 1200 + 15% tax = 1380.
  const august = await quotePrice(pool, { serviceCode: 'CONSULT-GP', onDate: '2026-08-15' });
  assert.equal(august.ruleVersion, 2);
  assert.equal(august.applied.minor, 1200);
  assert.equal(august.tax.minor, 180);
  assert.equal(august.total.minor, 1380);

  // No fee effective before the schedule starts.
  await assert.rejects(quotePrice(pool, { serviceCode: 'CONSULT-GP', onDate: '2025-12-31' }), PriceError);
  await assert.rejects(quotePrice(pool, { serviceCode: 'NO-SUCH', onDate: '2026-08-15' }), PriceError);
});

test('price overrides obey the reason/approver rules (BIL-003)', { skip }, async () => {
  // Away from standard needs a reason.
  await assert.rejects(quotePrice(pool, { serviceCode: 'CONSULT-GP', onDate: '2026-06-15', appliedMinor: 900 }), /reason/);
  // Within band with a reason is fine.
  const within = await quotePrice(pool, { serviceCode: 'CONSULT-GP', onDate: '2026-06-15', appliedMinor: 900, reason: 'concession' });
  assert.equal(within.applied.minor, 900);
  assert.equal(within.adjustment.minor, -100);
  // Outside the band (min 800) needs an approver.
  await assert.rejects(quotePrice(pool, { serviceCode: 'CONSULT-GP', onDate: '2026-06-15', appliedMinor: 500, reason: 'hardship' }), /approver/);
  const outside = await quotePrice(pool, { serviceCode: 'CONSULT-GP', onDate: '2026-06-15', appliedMinor: 500, reason: 'hardship', approver: FINANCE });
  assert.equal(outside.applied.minor, 500);
});

test('charging a service retains applied pricing and posts a balanced journal with tax split (BIL-001)', { skip }, async () => {
  const taxBefore = await accountCredit('2300-TAX-PAYABLE');
  const charge = await chargeService(pool, { patientId: PATIENT, serviceCode: 'CONSULT-GP', onDate: '2026-08-15', user: FINANCE });
  assert.equal(charge.totalMinor, 1380);

  // The line retains the version + standard/applied/tax.
  const line = await pool.query(`SELECT rule_version, standard_minor, applied_minor, tax_minor FROM billing.invoice_line WHERE invoice_id=$1`, [charge.invoiceId]);
  assert.equal(line.rows[0].rule_version, 2);
  assert.equal(Number(line.rows[0].applied_minor), 1200);
  assert.equal(Number(line.rows[0].tax_minor), 180);

  // Outstanding = applied + tax; the trial balance stays balanced; tax booked to the liability.
  assert.equal(await invoiceOutstanding(pool, charge.invoiceId), 1380);
  assert.equal((await trialBalance(pool)).balanced, true);
  assert.equal(await accountCredit('2300-TAX-PAYABLE'), taxBefore + 180);
});

test('an out-of-band charge needs an approver; the override is retained (BIL-003)', { skip }, async () => {
  await assert.rejects(chargeService(pool, { patientId: PATIENT, serviceCode: 'CONSULT-GP', onDate: '2026-06-15', appliedMinor: 500, reason: 'hardship' }), /approver/);
  const charge = await chargeService(pool, { patientId: PATIENT, serviceCode: 'CONSULT-GP', onDate: '2026-06-15', appliedMinor: 500, reason: 'hardship', approver: FINANCE, user: FINANCE });
  const line = await pool.query(`SELECT applied_minor, reason, approver FROM billing.invoice_line WHERE invoice_id=$1`, [charge.invoiceId]);
  assert.equal(Number(line.rows[0].applied_minor), 500);
  assert.equal(line.rows[0].reason, 'hardship');
  assert.equal(line.rows[0].approver, FINANCE);
});

test('the fee schedule can be revised forward-dated (BIL-001)', { skip }, async () => {
  await assert.rejects(defineFee(pool, { serviceCode: 'DRESSING', effectiveFrom: '2026-10-01', standardMinor: 100, minMinor: 200, maxMinor: 300, by: ADMIN }), PricingError); // min>standard
  // DRESSING v1 starts 2026-01-01; a revision must be later.
  await assert.rejects(defineFee(pool, { serviceCode: 'DRESSING', effectiveFrom: '2025-06-01', standardMinor: 600, minMinor: 500, maxMinor: 1000, by: ADMIN }), /must be after/);

  const rev = await defineFee(pool, { serviceCode: 'DRESSING', effectiveFrom: '2026-10-01', standardMinor: 700, minMinor: 600, maxMinor: 1100, taxRateBps: 1500, by: ADMIN });
  assert.equal(rev.version, 2);
  assert.equal((await quotePrice(pool, { serviceCode: 'DRESSING', onDate: '2026-09-30' })).applied.minor, 500); // still v1
  const nov = await quotePrice(pool, { serviceCode: 'DRESSING', onDate: '2026-11-01' });
  assert.equal(nov.applied.minor, 700); // v2
  assert.equal(nov.tax.minor, 105); // 15%
  assert.ok((await listFees(pool, 'DRESSING')).length >= 2);
});
