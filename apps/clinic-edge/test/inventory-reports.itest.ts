/**
 * Reorder suggestions (INV-007) + movement report (INV-011) against real
 * PostgreSQL. Proves: a SKU below its reorder minimum is suggested (with
 * assumptions), and the movement report sums received/dispensed/adjustment from
 * the immutable movement records over a period.
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
import { reorderSuggestions, stockMovementReport } from '../src/inventory-reports.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const LOT1 = '00000000-0000-7000-8000-000000000a01';

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

test('a SKU below its reorder minimum is suggested with assumptions (INV-007)', { skip }, async () => {
  // Seed on-hand for AMOX-500 is 1500; reorder_min 200 → not suggested.
  assert.ok(!(await reorderSuggestions(pool)).some((s) => s.sku === 'AMOX-500'));

  // Draw it down below the minimum with a dispense movement.
  await pool.query(`INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity, occurred_at) VALUES (gen_random_uuid(),'AMOX-500',$1,'MAIN','dispense',-1400, now())`, [LOT1]);
  const s = (await reorderSuggestions(pool)).find((x) => x.sku === 'AMOX-500');
  assert.ok(s, 'AMOX-500 should now be suggested');
  assert.equal(s!.suggest, true);
  assert.equal(s!.suggestedQty, 1000 - 100); // reorder_max 1000 − on-hand 100
  assert.equal(s!.assumptions.reorderMin, 200);
  assert.ok(s!.assumptions.avgDailyUse! > 0); // estimated from the dispense
});

test('the movement report sums received/dispensed/adjustment (INV-011)', { skip }, async () => {
  const rep = await stockMovementReport(pool, { from: '2026-01-01', to: '2027-01-01' });
  const amox = rep.rows.find((r) => r.sku === 'AMOX-500')!;
  assert.ok(amox);
  assert.equal(amox.receivedQty, 1500); // 1000 + 500 seed receipts
  assert.equal(amox.dispensedQty, 1400); // the dispense above (positive magnitude)
  assert.equal(amox.netQty, 100); // 1500 received − 1400 dispensed
});
