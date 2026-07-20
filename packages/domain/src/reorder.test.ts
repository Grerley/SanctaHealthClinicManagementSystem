import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reorderSuggestion } from './reorder.ts';

test('suggests bringing stock up to max when at/below min (INV-007)', () => {
  const s = reorderSuggestion({ sku: 'AMOX-500', onHand: 150, reorderMin: 200, reorderMax: 1000, avgDailyUse: 30 });
  assert.equal(s.suggest, true);
  assert.equal(s.suggestedQty, 850); // 1000 - 150
  assert.equal(s.coverDays, 5); // floor(150/30)
  assert.deepEqual(s.assumptions, { reorderMin: 200, reorderMax: 1000, avgDailyUse: 30 });
});

test('does not suggest when above the reorder minimum (INV-007)', () => {
  const s = reorderSuggestion({ sku: 'AMOX-500', onHand: 500, reorderMin: 200, reorderMax: 1000 });
  assert.equal(s.suggest, false);
  assert.equal(s.suggestedQty, 0);
});

test('falls back to twice the min when no max is configured', () => {
  const s = reorderSuggestion({ sku: 'X', onHand: 10, reorderMin: 50 });
  assert.equal(s.suggest, true);
  assert.equal(s.suggestedQty, 90); // 50*2 - 10
  assert.equal(s.coverDays, null); // no usage known
});

test('no reorder minimum → never suggests (no auto-order)', () => {
  assert.equal(reorderSuggestion({ sku: 'X', onHand: 0 }).suggest, false);
});
