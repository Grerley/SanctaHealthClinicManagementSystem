/**
 * Stocktake variance & approval on D1 (INV-008). Runs on real SQLite. Proves: a
 * zero variance is a no-op; a non-zero variance is refused without an approver;
 * an approved shrinkage posts a linked adjustment movement, brings the maintained
 * balance to the counted quantity, and posts a balanced Dr expense / Cr inventory
 * journal.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { performStocktake, StocktakeError } from '../src/stocktake.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const LOT = 'st-lot-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO inventory_lot (id, sku, expiry_date, unit_cost_minor) VALUES (?,?,?,?)`).bind(LOT, 'PARA-500', '2027-01-01', 200).run();
  await db.prepare(`INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity) VALUES (?,?,?,?,?,?)`).bind('m0', 'PARA-500', LOT, 'MAIN', 'receipt', 100).run();
  await db.prepare(`INSERT INTO inventory_stock_balance (lot_id, location, sku, on_hand) VALUES (?,?,?,?)`).bind(LOT, 'MAIN', 'PARA-500', 100).run();
});

test('a zero variance is a no-op', async () => {
  const r = await performStocktake(db, { lotId: LOT, countedQty: 100 });
  assert.equal(r.varianceQty, 0);
  const bal = await one<{ on_hand: number }>(db, `SELECT on_hand FROM inventory_stock_balance WHERE lot_id=? AND location='MAIN'`, [LOT]);
  assert.equal(bal?.on_hand, 100);
});

test('a variance needs an approver', async () => {
  await assert.rejects(() => performStocktake(db, { lotId: LOT, countedQty: 95 }), StocktakeError);
});

test('an approved shrinkage posts an adjustment + balanced journal and updates the balance', async () => {
  const r = await performStocktake(db, { lotId: LOT, countedQty: 95, approver: 'mgr1', postingDate: '2026-07-20' });
  assert.equal(r.bookQty, 100);
  assert.equal(r.varianceQty, -5);
  assert.equal(r.adjustmentValueMinor, 1000); // 5 * 200
  const bal = await one<{ on_hand: number }>(db, `SELECT on_hand FROM inventory_stock_balance WHERE lot_id=? AND location='MAIN'`, [LOT]);
  assert.equal(bal?.on_hand, 95);
  const mv = await one<{ n: number }>(db, `SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock_movement WHERE lot_id=? AND movement_type='adjustment'`, [LOT]);
  assert.equal(mv?.n, -5);
  const bal2 = await one<{ d: number; c: number }>(db,
    `SELECT COALESCE(SUM(debit_minor),0) AS d, COALESCE(SUM(credit_minor),0) AS c
     FROM finance_journal_line l JOIN finance_journal_batch b ON b.id=l.batch_id WHERE b.source_type='stocktake' AND b.source_id=?`, [LOT]);
  assert.equal(bal2?.d, 1000);
  assert.equal(bal2?.c, 1000);
  // Shrinkage debits the supplies/shrinkage expense account.
  const exp = await one<{ d: number }>(db,
    `SELECT COALESCE(SUM(debit_minor),0) AS d FROM finance_journal_line l JOIN finance_journal_batch b ON b.id=l.batch_id
     WHERE b.source_id=? AND l.account_code='5100-SUPPLIES-EXPENSE'`, [LOT]);
  assert.equal(exp?.d, 1000);
});
