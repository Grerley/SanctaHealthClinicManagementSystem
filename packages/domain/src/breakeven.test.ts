import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakEven, investmentRecovery, contributionMarginMinor, BreakEvenError } from './breakeven.ts';

test('break-even rounds up to whole units and reports revenue (FIN-012)', () => {
  // Fixed 100000c, price 500c, variable 300c → contribution 200c → 500 units.
  const be = breakEven({ fixedCostMinor: 100_000, unitPriceMinor: 500, unitVariableCostMinor: 300 });
  assert.equal(be.unitContributionMinor, 200);
  assert.equal(be.breakEvenUnits, 500);
  assert.equal(be.breakEvenRevenueMinor, 250_000);

  // Non-divisible → rounds up (can't sell a fraction of a unit).
  const be2 = breakEven({ fixedCostMinor: 100_001, unitPriceMinor: 500, unitVariableCostMinor: 300 });
  assert.equal(be2.breakEvenUnits, 501);
});

test('no positive contribution → break-even is unreachable (FIN-012)', () => {
  assert.equal(contributionMarginMinor(300, 300), 0);
  assert.throws(() => breakEven({ fixedCostMinor: 1000, unitPriceMinor: 300, unitVariableCostMinor: 300 }), BreakEvenError);
  assert.throws(() => breakEven({ fixedCostMinor: 1000, unitPriceMinor: 200, unitVariableCostMinor: 300 }), BreakEvenError);
});

test('investment recovery: funding offsets, surplus recovers, else never (FIN-012)', () => {
  // 1,000,000c investment, 400,000c funding → 600,000c outstanding; 50,000c/mo → 12 months.
  const r = investmentRecovery({ investmentMinor: 1_000_000, fundingMinor: 400_000, monthlyNetMinor: 50_000 });
  assert.equal(r.outstandingMinor, 600_000);
  assert.equal(r.recovered, false);
  assert.equal(r.recoveryMonths, 12);

  // Fully funded → already recovered.
  const funded = investmentRecovery({ investmentMinor: 500_000, fundingMinor: 500_000, monthlyNetMinor: 0 });
  assert.equal(funded.recovered, true);
  assert.equal(funded.recoveryMonths, 0);

  // No surplus → never recovers.
  const loss = investmentRecovery({ investmentMinor: 1_000_000, fundingMinor: 0, monthlyNetMinor: -1000 });
  assert.equal(loss.recoveryMonths, null);
  assert.equal(loss.recovered, false);
});
