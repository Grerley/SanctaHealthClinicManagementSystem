import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTotal, expectedCash, variance, requiresApproval, closeShift, CashierError } from './cashier.ts';

test('countTotal sums denominations in minor units', () => {
  // 3 x $50 + 4 x $1 + 5 x 10c = 15000 + 400 + 50 = 15450
  assert.equal(countTotal([{ unitMinor: 5000, count: 3 }, { unitMinor: 100, count: 4 }, { unitMinor: 10, count: 5 }]), 15450);
});

test('countTotal rejects negative or non-integer inputs', () => {
  assert.throws(() => countTotal([{ unitMinor: 100, count: -1 }]), CashierError);
  assert.throws(() => countTotal([{ unitMinor: 10.5, count: 1 }]), CashierError);
});

test('expected cash = float + receipts - pay-outs', () => {
  assert.equal(expectedCash(10000, 25000, 3000), 32000);
});

test('variance is counted minus expected', () => {
  assert.equal(variance(32000, 32000), 0);
  assert.equal(variance(31500, 32000), -500); // short
  assert.equal(variance(32200, 32000), 200); // over
});

test('a clean close within tolerance needs no approval (UAT-09)', () => {
  const r = closeShift({
    openingFloatMinor: 10000,
    cashReceiptsMinor: 22000,
    cashPayOutsMinor: 0,
    denominations: [{ unitMinor: 5000, count: 6 }, { unitMinor: 100, count: 20 }], // 30000 + 2000 = 32000
    toleranceMinor: 100,
  });
  assert.equal(r.expectedMinor, 32000);
  assert.equal(r.countedMinor, 32000);
  assert.equal(r.varianceMinor, 0);
  assert.equal(r.requiresApproval, false);
  assert.equal(r.status, 'closed');
});

test('variance above tolerance cannot close without a supervisor approver (BIL-009)', () => {
  const input = {
    openingFloatMinor: 10000,
    cashReceiptsMinor: 22000,
    cashPayOutsMinor: 0,
    denominations: [{ unitMinor: 5000, count: 6 }, { unitMinor: 100, count: 5 }], // 30000 + 500 = 30500
    toleranceMinor: 100,
  };
  // expected 32000, counted 30500 -> variance -1500, |1500| > 100
  assert.throws(() => closeShift(input), CashierError);
  const approved = closeShift(input, { approver: 'supervisor-1' });
  assert.equal(approved.varianceMinor, -1500);
  assert.equal(approved.requiresApproval, true);
  assert.equal(approved.approved, true);
  assert.equal(approved.status, 'closed');
});

test('requiresApproval is symmetric around zero', () => {
  assert.equal(requiresApproval(150, 100), true);
  assert.equal(requiresApproval(-150, 100), true);
  assert.equal(requiresApproval(100, 100), false);
});
