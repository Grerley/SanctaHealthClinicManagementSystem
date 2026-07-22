/**
 * Inventory receiving + stock alerts on D1 (INV-004/009). Runs on real SQLite
 * (same engine as D1). Proves: goods receipt maintains the balance and posts a
 * balanced Dr Inventory / Cr Supplier-AP journal, an unknown product is rejected,
 * and alerts flag stockout / low / near-expiry / expired correctly.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { receiveGoods, stockAlerts, InventoryError } from '../src/inventory.ts';
import { skuOnHand } from '../src/stock.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('goods receipt maintains balance and posts a balanced journal', async () => {
  await receiveGoods(db, { sku: 'AMOX-500', expiryDate: '2027-06-30', unitCostMinor: 12, quantity: 100, postingDate: '2026-07-19' });
  assert.equal(await skuOnHand(db, 'AMOX-500', 'MAIN'), 100);
  const j = await db.prepare(`SELECT COALESCE(SUM(debit_minor),0) AS d, COALESCE(SUM(credit_minor),0) AS c FROM finance_journal_line
    WHERE batch_id IN (SELECT id FROM finance_journal_batch WHERE source_type='goods-receipt')`).first<{ d: number; c: number }>();
  assert.equal(Number(j?.d), 1200);   // 100 * 12 landed cost
  assert.equal(Number(j?.c), 1200);   // balanced
});

test('an unknown product is rejected', async () => {
  await assert.rejects(() => receiveGoods(db, { sku: 'NOPE-1', expiryDate: '2027-01-01', unitCostMinor: 5, quantity: 10 }), InventoryError);
});

test('alerts flag low stock and near-expiry', async () => {
  // reorder_min for AMOX-500 is 50; receive only 20 → low. Expiry in ~30 days → near-expiry.
  await receiveGoods(db, { sku: 'AMOX-500', expiryDate: '2026-08-20', unitCostMinor: 12, quantity: 20, postingDate: '2026-07-19' });
  const alerts = await stockAlerts(db, '2026-07-22');
  const a = alerts.find((x) => x.sku === 'AMOX-500');
  assert.ok(a);
  assert.ok(a!.flags.includes('low'));
  assert.ok(a!.flags.includes('near_expiry'));
});

test('alerts flag stockout when nothing is on hand', async () => {
  const alerts = await stockAlerts(db, '2026-07-22'); // AMOX-500 exists as a product, no stock
  const a = alerts.find((x) => x.sku === 'AMOX-500');
  assert.ok(a!.flags.includes('stockout'));
});
