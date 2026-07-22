/**
 * Phase D1 — the concurrency spike (go/no-go for the whole D1 migration).
 * Proves the D1 optimistic pattern preserves the INV-005 invariant WITHOUT row
 * locks: FEFO dispense never oversells, stock never goes negative, an over-draw is
 * rejected atomically with no side effects, and balance always equals Σ movements.
 *
 * Runs on real SQLite via node:sqlite (the same engine as Cloudflare D1).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openLocalD1, applyD1Migrations, receiveStock, dispenseStock, skuOnHand } from '../src/index.ts';
import { StockError } from '@sancta/domain';
import type { LocalD1 } from '../src/d1.ts';

const SKU = 'AMOX-500';
const LOC = 'MAIN';
let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

async function movementSum(): Promise<number> {
  const r = await db.prepare(`SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock_movement WHERE sku=?`).bind(SKU).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

test('FEFO dispense draws earliest-expiry first and reduces on-hand (INV-006)', async () => {
  await receiveStock(db, { sku: SKU, lotId: 'lot-late', expiryDate: '2027-01-01', unitCostMinor: 20, location: LOC, quantity: 100 });
  await receiveStock(db, { sku: SKU, lotId: 'lot-early', expiryDate: '2026-06-01', unitCostMinor: 12, location: LOC, quantity: 30 });

  const out = await dispenseStock(db, { sku: SKU, location: LOC, quantity: 40, asOfDate: '2026-01-01' });
  // 30 from the earliest-expiry lot @12, then 10 from the later @20.
  assert.deepEqual(out.plan.map((p) => [p.lotId, p.quantity]), [['lot-early', 30], ['lot-late', 10]]);
  assert.equal(out.cogsMinor, 30 * 12 + 10 * 20);
  assert.equal(await skuOnHand(db, SKU, LOC), 90); // 130 - 40
  assert.equal(await movementSum(), 90); // balance == Σ movements
});

test('an over-draw is rejected atomically with NO side effects (INV-005)', async () => {
  await receiveStock(db, { sku: SKU, lotId: 'lot-1', expiryDate: '2027-01-01', unitCostMinor: 20, location: LOC, quantity: 20 });

  await assert.rejects(dispenseStock(db, { sku: SKU, location: LOC, quantity: 25, asOfDate: '2026-01-01' }), StockError);
  // Nothing changed: on-hand intact, no dispense movement written.
  assert.equal(await skuOnHand(db, SKU, LOC), 20);
  assert.equal(await movementSum(), 20); // still just the receipt
});

test('serialised over-demand never oversells; on-hand never negative (INV-005, BR-007)', async () => {
  // 20 units available; 15 dispense attempts of 2 each = demand 30 > supply 20.
  await receiveStock(db, { sku: SKU, lotId: 'lot-1', expiryDate: '2027-01-01', unitCostMinor: 10, location: LOC, quantity: 20 });

  let dispensed = 0;
  let rejected = 0;
  for (let i = 0; i < 15; i++) {
    try {
      const r = await dispenseStock(db, { sku: SKU, location: LOC, quantity: 2, asOfDate: '2026-01-01' });
      dispensed += r.plan.reduce((s, p) => s + p.quantity, 0);
    } catch (e) {
      assert.ok(e instanceof StockError);
      rejected++;
    }
  }

  assert.equal(dispensed, 20, 'exactly the available stock is dispensed, never more');
  assert.equal(rejected, 5, 'the excess demand is rejected');
  const onHand = await skuOnHand(db, SKU, LOC);
  assert.equal(onHand, 0);
  assert.ok(onHand >= 0, 'on-hand never goes negative');
  assert.equal(await movementSum(), 0, 'balance still equals Σ movements');
});

test('the CHECK gate blocks a direct negative write (the lock replacement)', async () => {
  await receiveStock(db, { sku: SKU, lotId: 'lot-1', expiryDate: '2027-01-01', unitCostMinor: 10, location: LOC, quantity: 5 });
  // Simulate a lost race: force the balance below zero directly — the CHECK must reject.
  await assert.rejects(
    db.prepare(`UPDATE inventory_stock_balance SET on_hand = on_hand - 6 WHERE lot_id='lot-1' AND location=?`).bind(LOC).run(),
    /CHECK|constraint/i,
  );
  assert.equal(await skuOnHand(db, SKU, LOC), 5);
});
