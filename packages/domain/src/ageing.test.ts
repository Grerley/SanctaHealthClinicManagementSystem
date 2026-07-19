import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type OpenItem, ageDebtors, ageingTotal, bandFor, reconcilesToControl } from './ageing.ts';
import { money } from './money.ts';

const items: OpenItem[] = [
  { invoiceId: 'i1', dueDate: '2026-07-10', outstandingMinor: 1000, currency: 'USD' }, // 9 days -> 0-30
  { invoiceId: 'i2', dueDate: '2026-06-01', outstandingMinor: 2000, currency: 'USD' }, // ~48 days -> 31-60
  { invoiceId: 'i3', dueDate: '2026-04-01', outstandingMinor: 3000, currency: 'USD' }, // >90 -> 90+
  { invoiceId: 'i4', dueDate: '2026-07-01', outstandingMinor: 0, currency: 'USD' }, // ignored
];

const asOf = '2026-07-19';

test('assigns items to the correct ageing band by as-of date', () => {
  assert.equal(bandFor('2026-07-10', asOf), '0-30');
  assert.equal(bandFor('2026-06-01', asOf), '31-60');
  assert.equal(bandFor('2026-04-01', asOf), '90+');
});

test('ages a debtor set and ignores zero-outstanding items', () => {
  const b = ageDebtors(items, asOf);
  assert.equal(b['0-30'].minor, 1000);
  assert.equal(b['31-60'].minor, 2000);
  assert.equal(b['61-90'].minor, 0);
  assert.equal(b['90+'].minor, 3000);
});

test('ageing total sums all bands', () => {
  const b = ageDebtors(items, asOf);
  assert.equal(ageingTotal(b).minor, 6000);
});

test('ageing recomputes by as-of date (later date shifts bands)', () => {
  const later = ageDebtors(items, '2026-08-19');
  // i1 due 2026-07-10 is now ~40 days -> 31-60
  assert.equal(later['0-30'].minor, 0);
  assert.equal(later['31-60'].minor, 1000);
});

test('ageing total reconciles to the AR control account (BIL-008)', () => {
  const b = ageDebtors(items, asOf);
  assert.ok(reconcilesToControl(b, money(6000)));
  assert.equal(reconcilesToControl(b, money(5999)), false);
});
