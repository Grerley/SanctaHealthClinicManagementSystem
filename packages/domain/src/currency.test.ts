import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBaseCurrency, CurrencyError } from './currency.ts';

test('a base-currency amount converts 1:1 (FIN-013)', () => {
  const r = toBaseCurrency(1500, 'USD', 9999);
  assert.equal(r.base.minor, 1500);
  assert.equal(r.base.currency, 'USD');
  assert.equal(r.rateBps, 10000);
});

test('a foreign amount converts by the rate, retaining the original (FIN-013)', () => {
  const r = toBaseCurrency(1000, 'EUR', 10800); // 1 EUR = 1.08 USD
  assert.equal(r.original.minor, 1000);
  assert.equal(r.original.currency, 'EUR');
  assert.equal(r.base.minor, 1080);
  assert.equal(r.base.currency, 'USD');
});

test('conversion rounds to exact minor units (no float drift)', () => {
  assert.equal(toBaseCurrency(333, 'GBP', 12500).base.minor, 416); // 333*1.25 = 416.25 → 416
  assert.equal(toBaseCurrency(1, 'GBP', 15000).base.minor, 2); // 1.5 → 2
});

test('invalid inputs are rejected', () => {
  assert.throws(() => toBaseCurrency(100.5, 'EUR', 10800), CurrencyError);
  assert.throws(() => toBaseCurrency(100, 'EUR', 0), CurrencyError);
  assert.throws(() => toBaseCurrency(100, 'EUR', -5), CurrencyError);
});
