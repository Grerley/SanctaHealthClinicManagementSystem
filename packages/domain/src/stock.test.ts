import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Lot,
  type StockMovement,
  lotBalance,
  skuBalance,
  assertCanDecrement,
  fefoPick,
  planCostMinor,
  StockError,
} from './stock.ts';

function mv(id: string, sku: string, lotId: string, type: StockMovement['type'], quantity: number): StockMovement {
  return { id, sku, lotId, location: 'MAIN', type, quantity, occurredAt: '2026-07-19T08:00:00Z' };
}

const lots: Lot[] = [
  { id: 'L1', sku: 'AMOX-500', expiryDate: '2026-09-01', status: 'available', unitCostMinor: 10 },
  { id: 'L2', sku: 'AMOX-500', expiryDate: '2026-08-01', status: 'available', unitCostMinor: 12 },
  { id: 'L3', sku: 'AMOX-500', expiryDate: '2026-07-10', status: 'available', unitCostMinor: 8 }, // expired
  { id: 'L4', sku: 'AMOX-500', expiryDate: '2027-01-01', status: 'quarantined', unitCostMinor: 9 },
];

const stock: StockMovement[] = [
  mv('m1', 'AMOX-500', 'L1', 'receipt', 100),
  mv('m2', 'AMOX-500', 'L2', 'receipt', 50),
  mv('m3', 'AMOX-500', 'L3', 'receipt', 30),
  mv('m4', 'AMOX-500', 'L4', 'receipt', 40),
];

test('balance is derived from immutable movements (BR-007)', () => {
  const withDispense = [...stock, mv('m5', 'AMOX-500', 'L1', 'dispense', -20)];
  assert.equal(lotBalance(withDispense, 'L1'), 80);
  assert.equal(skuBalance(withDispense, 'AMOX-500'), 100 + 50 + 30 + 40 - 20);
});

test('negative stock is blocked by default (INV-005)', () => {
  assert.throws(() => assertCanDecrement(stock, 'L2', 51), StockError);
  assert.doesNotThrow(() => assertCanDecrement(stock, 'L2', 50));
});

test('FEFO picks earliest-expiry available lot first (MED-007)', () => {
  const plan = fefoPick(lots, stock, 'AMOX-500', 40, '2026-07-19');
  // L2 (2026-08-01) is the earliest non-expired available lot
  assert.equal(plan[0]?.lotId, 'L2');
  assert.equal(plan[0]?.quantity, 40);
});

test('FEFO skips expired and quarantined lots (MED-008)', () => {
  // Require more than L2 (50) + L1 (100) can supply if L3/L4 were eligible,
  // but they are not: expired L3 and quarantined L4 must be excluded.
  const plan = fefoPick(lots, stock, 'AMOX-500', 150, '2026-07-19');
  const usedLots = plan.map((p) => p.lotId).sort();
  assert.deepEqual(usedLots, ['L1', 'L2']);
  assert.ok(!plan.some((p) => p.lotId === 'L3' || p.lotId === 'L4'));
});

test('FEFO throws when dispensable stock is insufficient', () => {
  // L1(100) + L2(50) = 150 dispensable; asking 151 must fail
  assert.throws(() => fefoPick(lots, stock, 'AMOX-500', 151, '2026-07-19'), StockError);
});

test('plan cost sums quantity * unit cost for COGS', () => {
  const plan = fefoPick(lots, stock, 'AMOX-500', 60, '2026-07-19');
  // 50 from L2 @12 + 10 from L1 @10 = 600 + 100 = 700
  assert.equal(planCostMinor(plan), 700);
});
