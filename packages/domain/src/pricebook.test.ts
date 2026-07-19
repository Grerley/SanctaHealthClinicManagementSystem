import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type FeeVersion, resolveFee, applyPrice, PriceError } from './pricebook.ts';

const schedule: FeeVersion[] = [
  { serviceCode: 'CONSULT', version: 1, effectiveFrom: '2026-01-01', effectiveTo: '2026-07-01', standardMinor: 1000, minMinor: 800, maxMinor: 1500, currency: 'USD' },
  { serviceCode: 'CONSULT', version: 2, effectiveFrom: '2026-07-01', standardMinor: 1200, minMinor: 1000, maxMinor: 1800, taxRateBps: 1500, currency: 'USD' },
];

test('resolves the fee version effective on a date (BR-005)', () => {
  assert.equal(resolveFee(schedule, 'CONSULT', '2026-03-15').version, 1);
  assert.equal(resolveFee(schedule, 'CONSULT', '2026-07-19').version, 2);
});

test('historical date keeps the old price (invoices retain applied version)', () => {
  const v = resolveFee(schedule, 'CONSULT', '2026-06-30');
  assert.equal(v.standardMinor, 1000);
});

test('throws when no fee is effective', () => {
  assert.throws(() => resolveFee(schedule, 'CONSULT', '2025-01-01'), PriceError);
  assert.throws(() => resolveFee(schedule, 'UNKNOWN', '2026-07-19'), PriceError);
});

test('standard price computes tax and total', () => {
  const fee = resolveFee(schedule, 'CONSULT', '2026-07-19');
  const p = applyPrice(fee);
  assert.equal(p.applied.minor, 1200);
  assert.equal(p.tax.minor, 180); // 15% of 1200
  assert.equal(p.total.minor, 1380);
  assert.equal(p.adjustment.minor, 0);
  assert.equal(p.ruleVersion, 2);
});

test('override within band requires a reason (BIL-003)', () => {
  const fee = resolveFee(schedule, 'CONSULT', '2026-07-19');
  assert.throws(() => applyPrice(fee, { appliedMinor: 1100 }), PriceError);
  const p = applyPrice(fee, { appliedMinor: 1100, reason: 'staff discount' });
  assert.equal(p.applied.minor, 1100);
  assert.equal(p.adjustment.minor, -100);
  assert.equal(p.reason, 'staff discount');
});

test('override outside band also requires an approver (BIL-003)', () => {
  const fee = resolveFee(schedule, 'CONSULT', '2026-07-19');
  assert.throws(() => applyPrice(fee, { appliedMinor: 500, reason: 'hardship' }), PriceError);
  const p = applyPrice(fee, { appliedMinor: 500, reason: 'hardship', approver: 'manager-1' });
  assert.equal(p.applied.minor, 500);
  assert.equal(p.approver, 'manager-1');
});
