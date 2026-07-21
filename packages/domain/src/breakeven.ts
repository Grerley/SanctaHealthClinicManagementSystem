/**
 * Start-up investment, funding recovery & break-even (FIN-012, pack §10.4). Pure
 * arithmetic on minor currency units (USD cents) so the planning figures are
 * exact and unit-tested. Contribution margin drives break-even; net monthly
 * surplus drives investment recovery. Guards make the "never recovers" and
 * "no contribution" cases explicit rather than dividing by zero.
 */

export class BreakEvenError extends Error {}

/** Contribution per unit = price − variable cost (minor units). May be ≤ 0. */
export function contributionMarginMinor(unitPriceMinor: number, unitVariableCostMinor: number): number {
  return unitPriceMinor - unitVariableCostMinor;
}

export type BreakEven = { unitContributionMinor: number; breakEvenUnits: number; breakEvenRevenueMinor: number };

/**
 * Units (and revenue) needed to cover fixed costs (FIN-012). Throws if a unit
 * never contributes (price ≤ variable cost) — there is no break-even to report.
 */
export function breakEven(args: { fixedCostMinor: number; unitPriceMinor: number; unitVariableCostMinor: number }): BreakEven {
  const unitContributionMinor = contributionMarginMinor(args.unitPriceMinor, args.unitVariableCostMinor);
  if (unitContributionMinor <= 0) throw new BreakEvenError('no positive contribution margin — break-even is unreachable');
  if (args.fixedCostMinor < 0) throw new BreakEvenError('fixed cost cannot be negative');
  const breakEvenUnits = Math.ceil(args.fixedCostMinor / unitContributionMinor);
  return { unitContributionMinor, breakEvenUnits, breakEvenRevenueMinor: breakEvenUnits * args.unitPriceMinor };
}

export type Recovery = { outstandingMinor: number; recovered: boolean; recoveryMonths: number | null };

/**
 * Investment recovery (FIN-012). Funding offsets the up-front investment; the
 * remainder is recovered from monthly net surplus. Returns recoveryMonths=null
 * when the surplus is ≤ 0 (the investment is never recovered) or already covered.
 */
export function investmentRecovery(args: { investmentMinor: number; fundingMinor: number; monthlyNetMinor: number }): Recovery {
  const outstandingMinor = args.investmentMinor - args.fundingMinor;
  if (outstandingMinor <= 0) return { outstandingMinor, recovered: true, recoveryMonths: 0 };
  if (args.monthlyNetMinor <= 0) return { outstandingMinor, recovered: false, recoveryMonths: null };
  return { outstandingMinor, recovered: false, recoveryMonths: Math.ceil(outstandingMinor / args.monthlyNetMinor) };
}
