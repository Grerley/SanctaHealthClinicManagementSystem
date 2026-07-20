import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResult, criticalIsOpen, minutesOpen, ResultError } from './results.ts';

test('a value within the reference range is normal and not critical', () => {
  const r = classifyResult(5.0, { refLow: 4, refHigh: 7.8 });
  assert.equal(r.abnormal, 'normal');
  assert.equal(r.critical, false);
});

test('below/above the reference range flags low/high', () => {
  assert.equal(classifyResult(3, { refLow: 4, refHigh: 7.8 }).abnormal, 'low');
  assert.equal(classifyResult(9, { refLow: 4, refHigh: 7.8 }).abnormal, 'high');
});

test('beyond a critical bound flags critical (ORD-006)', () => {
  const low = classifyResult(1.8, { refLow: 4, refHigh: 7.8, criticalLow: 2.2 });
  assert.equal(low.abnormal, 'low');
  assert.equal(low.critical, true);
  const high = classifyResult(30, { refLow: 4, refHigh: 7.8, criticalHigh: 25 });
  assert.equal(high.critical, true);
});

test('critical stays open until acknowledged', () => {
  assert.equal(criticalIsOpen(true, null), true);
  assert.equal(criticalIsOpen(true, '2026-07-19T10:00:00Z'), false);
  assert.equal(criticalIsOpen(false, null), false);
});

test('minutesOpen measures escalation time', () => {
  const base = Date.parse('2026-07-19T10:00:00Z');
  assert.equal(minutesOpen(base, base + 45 * 60_000), 45);
});

test('rejects a non-finite value', () => {
  assert.throws(() => classifyResult(Number.NaN, {}), ResultError);
});
