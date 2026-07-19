import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, add, subtract, sum, compare, format, isNegative, MoneyError } from './money.ts';

test('add and subtract are exact in minor units', () => {
  assert.equal(add(money(150), money(250)).minor, 400);
  assert.equal(subtract(money(1000), money(1)).minor, 999);
});

test('no floating point drift (0.1 + 0.2 problem)', () => {
  // 10c + 20c must be exactly 30c
  assert.equal(add(money(10), money(20)).minor, 30);
});

test('sum reduces a list', () => {
  assert.equal(sum([money(100), money(200), money(50)]).minor, 350);
});

test('currency mismatch is rejected', () => {
  assert.throws(() => add(money(100, 'USD'), money(100, 'ZWL')), MoneyError);
});

test('non-integer minor units are rejected', () => {
  assert.throws(() => money(10.5), MoneyError);
});

test('compare orders values', () => {
  assert.equal(compare(money(100), money(200)), -1);
  assert.equal(compare(money(200), money(200)), 0);
  assert.equal(compare(money(300), money(200)), 1);
});

test('isNegative and format', () => {
  assert.ok(isNegative(money(-5)));
  assert.equal(format(money(1234)), 'USD 12.34');
  assert.equal(format(money(-1234)), '-USD 12.34');
  assert.equal(format(money(5)), 'USD 0.05');
});
