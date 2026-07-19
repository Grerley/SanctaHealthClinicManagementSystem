import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Lot, type StockMovement, lotBalance, isBalanced, accountBalance, ACCOUNTS } from '@sancta/domain';
import { planDispense, type DispenseRequest } from './dispense.ts';

const lots: Lot[] = [
  { id: 'L1', sku: 'AMOX-500', expiryDate: '2026-09-01', status: 'available', unitCostMinor: 10 },
  { id: 'L2', sku: 'AMOX-500', expiryDate: '2026-08-01', status: 'available', unitCostMinor: 12 },
  { id: 'LX', sku: 'AMOX-500', expiryDate: '2026-07-10', status: 'available', unitCostMinor: 8 }, // expired
];
const movements: StockMovement[] = [
  { id: 'm1', sku: 'AMOX-500', lotId: 'L1', location: 'MAIN', type: 'receipt', quantity: 100, occurredAt: '2026-07-01T00:00:00Z' },
  { id: 'm2', sku: 'AMOX-500', lotId: 'L2', location: 'MAIN', type: 'receipt', quantity: 50, occurredAt: '2026-07-01T00:00:00Z' },
  { id: 'm3', sku: 'AMOX-500', lotId: 'LX', location: 'MAIN', type: 'receipt', quantity: 30, occurredAt: '2026-07-01T00:00:00Z' },
];

const req: DispenseRequest = {
  sku: 'AMOX-500',
  quantity: 60,
  patientId: 'pat-1',
  encounterId: 'enc-1',
  invoiceId: 'inv-1',
  chargeMinor: 1500,
  asOfDate: '2026-07-19',
  postingDate: '2026-07-19',
  location: 'MAIN',
  device: 'D1',
  user: 'U1',
  site: 'S1',
};

test('dispense plans FEFO decrements, COGS and revenue together (BR-008)', () => {
  const plan = planDispense(req, lots, movements, 1_700_000_000_000);
  // 50 from L2 (earliest non-expired) + 10 from L1
  const byLot = new Map<string, number>();
  for (const m of plan.movements) byLot.set(m.lotId, -m.quantity);
  assert.equal(byLot.get('L2'), 50);
  assert.equal(byLot.get('L1'), 10);
  assert.ok(!byLot.has('LX'), 'expired lot must not be dispensed');

  // COGS = 50*12 + 10*10 = 700
  assert.equal(plan.cogsMinor, 700);
  assert.ok(isBalanced(plan.cogs));
  assert.ok(isBalanced(plan.revenue));
  assert.equal(accountBalance([plan.cogs], ACCOUNTS.cogs).minor, 700);
  assert.equal(accountBalance([plan.revenue], ACCOUNTS.patientAR).minor, 1500);
});

test('resulting balances reconcile: applying movements decrements on-hand', () => {
  const plan = planDispense(req, lots, movements, 1_700_000_000_000);
  const after = [...movements, ...plan.movements];
  assert.equal(lotBalance(after, 'L2'), 0);
  assert.equal(lotBalance(after, 'L1'), 90);
});

test('insufficient dispensable stock throws — nothing is committed', () => {
  assert.throws(() => planDispense({ ...req, quantity: 200 }, lots, movements), /insufficient/);
});

test('idempotency key is stable for the same dispense', () => {
  const a = planDispense(req, lots, movements, 1);
  const b = planDispense(req, lots, movements, 2);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});
