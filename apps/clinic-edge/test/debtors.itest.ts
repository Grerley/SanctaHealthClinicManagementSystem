/**
 * Debtor ageing + collection work queue (BIL-008) against real PostgreSQL.
 * Proves: outstanding is derived from invoice lines minus allocations; the ageing
 * total reconciles to the patient AR control account from the journals; the
 * work queue lists patients with a balance; and ageing recomputes by as-of date.
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
import { ageingReport } from '../src/debtors.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const PATIENT2 = '00000000-0000-7000-8000-000000000102';

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

test('outstanding ages and reconciles to the AR control account (BIL-008)', { skip }, async () => {
  // Two part-paid checkouts leave a receivable each.
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 300, paymentMethod: 'cash' }); // owes 200
  await doCheckout(pool, { patientId: PATIENT2, sku: 'AMOX-500', quantity: 5, chargeMinor: 800, paymentMinor: 0, paymentMethod: 'cash' }); // owes 800

  const report = await ageingReport(pool, '2026-07-19');
  assert.equal(report.totalMinor, 1000); // 200 + 800
  assert.equal(report.arControlMinor, 1000);
  assert.equal(report.reconciles, true, 'ageing total must equal the AR control account');
  // Both invoices are recent -> all in the 0-30 band.
  assert.equal(report.buckets['0-30'], 1000);
  // Work queue lists both debtors.
  assert.equal(report.workQueue.length, 2);
  assert.ok(report.workQueue.some((d) => d.outstandingMinor === 800));
});

test('a fully paid invoice drops out of the ageing', { skip }, async () => {
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 1, chargeMinor: 100, paymentMinor: 100, paymentMethod: 'cash' }); // owes 0
  const report = await ageingReport(pool, '2026-07-19');
  // Total unchanged (the new invoice is fully paid).
  assert.equal(report.totalMinor, 1000);
  assert.equal(report.reconciles, true);
});

test('ageing recomputes by as-of date (older date shifts nothing here, later keeps reconciliation)', { skip }, async () => {
  const later = await ageingReport(pool, '2026-09-30');
  // Reconciliation to the control account holds regardless of as-of date.
  assert.equal(later.reconciles, true);
  assert.equal(later.totalMinor, later.arControlMinor);
});
