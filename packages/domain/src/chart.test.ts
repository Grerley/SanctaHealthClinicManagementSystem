import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccount, chartAsOf, assertAccountType, assertAccountCode, isAccountType, ChartError, type AccountVersion } from './chart.ts';

const V: AccountVersion[] = [
  { code: '4000-SERVICE-REVENUE', version: 1, name: 'Service income', type: 'revenue', active: true, effectiveFrom: '2026-01-01', effectiveTo: '2026-07-01' },
  { code: '4000-SERVICE-REVENUE', version: 2, name: 'Service revenue', type: 'revenue', active: true, effectiveFrom: '2026-07-01' },
  { code: '6950-OLD', version: 1, name: 'Retired account', type: 'expense', active: false, effectiveFrom: '2026-01-01' },
];

test('resolves the definition in force on a date', () => {
  assert.equal(resolveAccount(V, '4000-SERVICE-REVENUE', '2026-03-15').name, 'Service income');
  assert.equal(resolveAccount(V, '4000-SERVICE-REVENUE', '2026-07-01').name, 'Service revenue'); // effectiveFrom inclusive
  assert.equal(resolveAccount(V, '4000-SERVICE-REVENUE', '2026-12-31').version, 2);
});

test('throws when no version covers the date', () => {
  assert.throws(() => resolveAccount(V, '4000-SERVICE-REVENUE', '2025-12-31'), ChartError);
  assert.throws(() => resolveAccount(V, 'NO-SUCH', '2026-07-01'), ChartError);
});

test('chartAsOf returns only active accounts effective on the date', () => {
  const chart = chartAsOf(V, '2026-08-01');
  assert.equal(chart.length, 1); // the retired inactive account is excluded
  assert.equal(chart[0]!.code, '4000-SERVICE-REVENUE');
  assert.equal(chart[0]!.name, 'Service revenue');
});

test('account type validation', () => {
  assert.equal(isAccountType('asset'), true);
  assert.equal(isAccountType('bogus'), false);
  assert.doesNotThrow(() => assertAccountType('liability'));
  assert.throws(() => assertAccountType('income'), ChartError);
});

test('account code validation enforces NNNN-UPPER-KEBAB', () => {
  assert.doesNotThrow(() => assertAccountCode('4000-SERVICE-REVENUE'));
  assert.doesNotThrow(() => assertAccountCode('100-CASH'));
  assert.throws(() => assertAccountCode('cash'), ChartError);
  assert.throws(() => assertAccountCode('4000_service'), ChartError);
});
