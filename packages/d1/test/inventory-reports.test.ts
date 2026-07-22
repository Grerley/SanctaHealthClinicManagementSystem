/**
 * Reorder suggestions + movement reporting on D1 (INV-007, INV-011). Runs on real
 * SQLite. Proves: a product at/below its reorder minimum is suggested (up to max)
 * while one above minimum is not; and the movement report sums receipts, dispenses
 * and adjustments by type from the immutable movement records over a period.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reorderSuggestions, stockMovementReport } from '../src/inventory-reports.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  // LOW is below its reorder minimum; OK is above it; NONE has no reorder settings.
  await db.prepare(`INSERT INTO inventory_product (sku, name, base_unit, reorder_min, reorder_max) VALUES ('LOW','Low stock item','ea',100,500)`).run();
  await db.prepare(`INSERT INTO inventory_product (sku, name, base_unit, reorder_min, reorder_max) VALUES ('OK','Well stocked item','ea',10,100)`).run();
  await db.prepare(`INSERT INTO inventory_product (sku, name, base_unit) VALUES ('NONE','Unmanaged item','ea')`).run();
  await db.prepare(`INSERT INTO inventory_lot (id, sku, expiry_date, unit_cost_minor) VALUES ('l-low','LOW','2027-01-01',100)`).run();
  await db.prepare(`INSERT INTO inventory_lot (id, sku, expiry_date, unit_cost_minor) VALUES ('l-ok','OK','2027-01-01',100)`).run();
  await db.prepare(`INSERT INTO inventory_stock_balance (lot_id, location, sku, on_hand) VALUES ('l-low','MAIN','LOW',40)`).run();
  await db.prepare(`INSERT INTO inventory_stock_balance (lot_id, location, sku, on_hand) VALUES ('l-ok','MAIN','OK',80)`).run();
});

test('only products at/below reorder minimum are suggested, up to max', async () => {
  const suggestions = await reorderSuggestions(db);
  const low = suggestions.find((s) => s.sku === 'LOW');
  assert.ok(low, 'LOW should be suggested');
  assert.equal(low.suggestedQty, 460); // 500 - 40
  assert.equal(suggestions.some((s) => s.sku === 'OK'), false); // above minimum
  assert.equal(suggestions.some((s) => s.sku === 'NONE'), false); // no reorder settings (no auto-order)
});

test('movement report sums receipts, dispenses and adjustments by type over a period', async () => {
  await db.prepare(`INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, occurred_at) VALUES ('r1','LOW','l-low','MAIN','receipt',100,'2026-07-05T09:00:00Z')`).run();
  await db.prepare(`INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, occurred_at) VALUES ('d1','LOW','l-low','MAIN','dispense',-30,'2026-07-06T09:00:00Z')`).run();
  await db.prepare(`INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, occurred_at) VALUES ('a1','LOW','l-low','MAIN','adjustment',-5,'2026-07-07T09:00:00Z')`).run();
  // Outside the window — excluded.
  await db.prepare(`INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, occurred_at) VALUES ('r2','LOW','l-low','MAIN','receipt',999,'2026-08-01T09:00:00Z')`).run();

  const rep = await stockMovementReport(db, { from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' });
  assert.equal(rep.rows.length, 1);
  const row = rep.rows[0]!;
  assert.equal(row.sku, 'LOW');
  assert.equal(row.receivedQty, 100);
  assert.equal(row.dispensedQty, 30); // negated to a positive consumption figure
  assert.equal(row.adjustmentQty, -5);
  assert.equal(row.netQty, 65); // 100 - 30 - 5
});
