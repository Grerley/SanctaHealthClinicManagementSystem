import { test } from 'node:test';
import assert from 'node:assert/strict';
import { straightLineDepreciation, grossMargin, FinanceCalcError } from './finance-analytics.ts';

test('straight-line depreciation spreads the base and caps at salvage (FIN-008)', () => {
  // Cost 120000c, salvage 20000c, life 10 months → base 100000c → 10000c/month.
  const d = straightLineDepreciation({ costMinor: 120_000, salvageMinor: 20_000, usefulLifeMonths: 10, monthsElapsed: 3 });
  assert.equal(d.monthlyMinor, 10_000);
  assert.equal(d.accumulatedMinor, 30_000);
  assert.equal(d.netBookValueMinor, 90_000);

  // Beyond useful life → NBV never below salvage.
  const full = straightLineDepreciation({ costMinor: 120_000, salvageMinor: 20_000, usefulLifeMonths: 10, monthsElapsed: 99 });
  assert.equal(full.accumulatedMinor, 100_000);
  assert.equal(full.netBookValueMinor, 20_000); // == salvage
});

test('depreciation rejects invalid inputs (FIN-008)', () => {
  assert.throws(() => straightLineDepreciation({ costMinor: 100, salvageMinor: 0, usefulLifeMonths: 0, monthsElapsed: 1 }), FinanceCalcError);
  assert.throws(() => straightLineDepreciation({ costMinor: 100, salvageMinor: 200, usefulLifeMonths: 5, monthsElapsed: 1 }), FinanceCalcError);
});

test('gross margin computes value and percentage, guarding zero revenue (FIN-011)', () => {
  const m = grossMargin(5000, 2000);
  assert.equal(m.grossMarginMinor, 3000);
  assert.equal(m.marginPct, 60);

  // A loss shows a negative margin.
  const loss = grossMargin(1000, 1500);
  assert.equal(loss.grossMarginMinor, -500);
  assert.equal(loss.marginPct, -50);

  // Zero revenue → 0%, not a divide-by-zero.
  assert.equal(grossMargin(0, 0).marginPct, 0);
});
