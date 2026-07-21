/**
 * Finance analytics: straight-line depreciation and gross margin (FIN-008,
 * FIN-011, pack §10). Pure arithmetic on minor currency units so the figures are
 * exact and unit-tested. Depreciation is capped at the depreciable base (an asset
 * never depreciates below its salvage value); margin guards the zero-revenue case.
 */

export class FinanceCalcError extends Error {}

export type Depreciation = { monthlyMinor: number; accumulatedMinor: number; netBookValueMinor: number };

/**
 * Straight-line depreciation of an asset (FIN-008). Depreciable base = cost −
 * salvage, spread evenly over the useful life; accumulated depreciation is capped
 * at the base so net book value never falls below salvage.
 */
export function straightLineDepreciation(args: { costMinor: number; salvageMinor: number; usefulLifeMonths: number; monthsElapsed: number }): Depreciation {
  if (args.usefulLifeMonths <= 0) throw new FinanceCalcError('useful life must be positive');
  if (args.costMinor < 0 || args.salvageMinor < 0) throw new FinanceCalcError('cost and salvage cannot be negative');
  if (args.salvageMinor > args.costMinor) throw new FinanceCalcError('salvage cannot exceed cost');
  const base = args.costMinor - args.salvageMinor;
  const monthlyMinor = Math.round(base / args.usefulLifeMonths);
  const months = Math.max(0, args.monthsElapsed);
  const accumulatedMinor = Math.min(base, monthlyMinor * months);
  return { monthlyMinor, accumulatedMinor, netBookValueMinor: args.costMinor - accumulatedMinor };
}

export type Margin = { revenueMinor: number; cogsMinor: number; grossMarginMinor: number; marginPct: number };

/**
 * Gross margin from revenue and actual cost of goods (FIN-011). marginPct is
 * gross margin over revenue, rounded to one decimal; zero revenue yields 0% (no
 * divide-by-zero) rather than an error, so an empty period reports cleanly.
 */
export function grossMargin(revenueMinor: number, cogsMinor: number): Margin {
  const grossMarginMinor = revenueMinor - cogsMinor;
  const marginPct = revenueMinor === 0 ? 0 : Math.round((grossMarginMinor / revenueMinor) * 1000) / 10;
  return { revenueMinor, cogsMinor, grossMarginMinor, marginPct };
}
