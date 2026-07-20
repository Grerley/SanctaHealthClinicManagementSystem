/**
 * Inventory receiving + stock alerts (INV-004/009) against real PostgreSQL.
 * Proves: goods receipt raises on-hand and posts Dr Inventory / Cr Supplier AP;
 * low-stock, stockout, near-expiry and expired signals are computed from the
 * movement ledger.
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
import { receiveGoods, stockAlerts, InventoryError } from '../src/inventory.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;

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

async function onHand(sku: string): Promise<number> {
  const r = await pool.query(`SELECT coalesce(sum(quantity),0)::int AS n FROM inventory.stock_movement WHERE sku=$1`, [sku]);
  return r.rows[0].n as number;
}
async function accountBal(code: string): Promise<number> {
  const r = await pool.query(`SELECT coalesce(sum(debit_minor)-sum(credit_minor),0)::int AS n FROM finance.journal_line WHERE account_code=$1`, [code]);
  return r.rows[0].n as number;
}

test('goods receipt raises on-hand and posts Dr Inventory / Cr Supplier AP (INV-004)', { skip }, async () => {
  const before = await onHand('AMOX-500');
  await receiveGoods(pool, { sku: 'AMOX-500', expiryDate: '2027-06-01', unitCostMinor: 11, quantity: 200, supplier: 'Synthetic Supplier A', poRef: 'PO-1' });
  assert.equal(await onHand('AMOX-500'), before + 200);
  // 200 * 11 = 2200 posted to inventory and supplier AP.
  assert.equal(await accountBal('1300-INVENTORY'), 2200);
  assert.equal(await accountBal('2100-SUPPLIER-AP'), -2200);
});

test('receiving into an unknown product is rejected', { skip }, async () => {
  await assert.rejects(receiveGoods(pool, { sku: 'NOPE', expiryDate: '2027-01-01', unitCostMinor: 5, quantity: 10 }), InventoryError);
});

test('stock alerts flag stockout, low, near-expiry and expired', { skip }, async () => {
  // A product with a small reorder floor and a near-expiry + an expired lot.
  await pool.query(`INSERT INTO inventory.product (sku, name, category, base_unit, reorder_min) VALUES ('GLOVE','Exam gloves (SYNTHETIC)','consumable','box',100)`);
  // near-expiry lot (within 60 days of as-of 2026-07-19) with stock
  await receiveGoods(pool, { sku: 'GLOVE', expiryDate: '2026-08-10', unitCostMinor: 50, quantity: 10 });
  // expired lot with stock
  await pool.query(`INSERT INTO inventory.lot (id, sku, expiry_date, status, unit_cost_minor) VALUES ('00000000-0000-7000-8000-0000000000ef','GLOVE','2026-07-01','available',50)`);
  await pool.query(`INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES ('00000000-0000-7000-8000-0000000000f0','GLOVE','00000000-0000-7000-8000-0000000000ef','MAIN','receipt',5,'seed')`);

  const alerts = await stockAlerts(pool, '2026-07-19');
  const glove = alerts.find((a) => a.sku === 'GLOVE');
  assert.ok(glove, 'GLOVE has alerts');
  // on-hand 15 < reorder 100 -> low; plus near_expiry and expired lots.
  assert.ok(glove!.flags.includes('low'));
  assert.ok(glove!.flags.includes('near_expiry'));
  assert.ok(glove!.flags.includes('expired'));

  // A SKU with zero stock flags stockout.
  await pool.query(`INSERT INTO inventory.product (sku, name, base_unit, reorder_min) VALUES ('MASK','Face mask (SYNTHETIC)','box',50)`);
  const alerts2 = await stockAlerts(pool, '2026-07-19');
  assert.ok(alerts2.find((a) => a.sku === 'MASK')?.flags.includes('stockout'));
});
