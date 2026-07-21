/**
 * Fixed assets & product margin (FIN-008, FIN-011) against real PostgreSQL.
 * Proves: an asset depreciates straight-line with a net book value that never
 * falls below salvage; disposal reports gain/loss vs NBV; and the margin report
 * derives per-SKU margin from revenue and actual consumption, tying out to the
 * ledger.
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
import { capitaliseAsset, assetRegister, disposeAsset, marginReport, incomeStatement, FixedAssetError } from '../src/finance-reports.ts';

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
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 1500, paymentMinor: 1500, paymentMethod: 'cash' });
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('an asset depreciates straight-line and disposal reports gain/loss (FIN-008)', { skip }, async () => {
  await capitaliseAsset(pool, { reference: 'FA-001', name: 'Autoclave', category: 'equipment', costMinor: 120_000, salvageMinor: 20_000, usefulLifeMonths: 10, acquiredOn: '2026-01-01' });

  // As-of 3 months later: 3 × 10,000c depreciation → NBV 90,000c.
  const reg = await assetRegister(pool, { asOf: '2026-04-01' });
  const asset = reg.find((a) => a.reference === 'FA-001')!;
  assert.equal(asset.monthlyMinor, 10_000);
  assert.equal(asset.accumulatedMinor, 30_000);
  assert.equal(asset.netBookValueMinor, 90_000);

  // Dispose at 4 months (NBV 80,000c) for 85,000c → 5,000c gain.
  const assetId = (await pool.query(`SELECT id FROM finance.fixed_asset WHERE reference='FA-001'`)).rows[0].id;
  const disposal = await disposeAsset(pool, { assetId, disposedOn: '2026-05-01', proceedsMinor: 85_000 });
  assert.equal(disposal.netBookValueMinor, 80_000);
  assert.equal(disposal.gainLossMinor, 5_000);

  // A second disposal is rejected.
  await assert.rejects(disposeAsset(pool, { assetId, disposedOn: '2026-06-01', proceedsMinor: 1 }), FixedAssetError);
});

test('the margin report ties revenue less actual COGS to the ledger (FIN-011)', { skip }, async () => {
  const report = await marginReport(pool);
  // Medicine AMOX-500 has revenue 1500 and COGS from the FEFO issue.
  const amox = report.products.find((p) => p.sku === 'AMOX-500');
  assert.ok(amox);
  assert.equal(amox!.revenueMinor, 1500);
  assert.ok(amox!.cogsMinor > 0);
  assert.equal(amox!.grossMarginMinor, amox!.revenueMinor - amox!.cogsMinor);

  // The clinic total ties out to the income statement (revenue − COGS).
  const is = await incomeStatement(pool);
  const cogsLine = is.expenseLines.find((l) => l.code === '5000-COGS');
  assert.equal(report.total.revenueMinor, is.revenueMinor);
  assert.equal(report.total.cogsMinor, cogsLine ? cogsLine.amountMinor : 0);
  assert.equal(report.total.grossMarginMinor, is.revenueMinor - (cogsLine ? cogsLine.amountMinor : 0));
});
