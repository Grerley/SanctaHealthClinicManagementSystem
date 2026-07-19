/**
 * Debtor ageing (BIL-008, pack §9). Ageing recomputes by as-of date and the
 * total must reconcile to the patient AR control account (never a stored total).
 */
import { type Money, money, add, zero } from './money.ts';

export type OpenItem = {
  readonly invoiceId: string;
  readonly dueDate: string; // ISO date
  /** Outstanding balance in minor units (invoice minus allocations). */
  readonly outstandingMinor: number;
  readonly currency: string;
};

export type AgeingBand = '0-30' | '31-60' | '61-90' | '90+';

export type AgeingBuckets = Readonly<Record<AgeingBand, Money>>;

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a);
  return Math.floor(ms / 86_400_000);
}

export function bandFor(dueDate: string, asOf: string): AgeingBand {
  const age = daysBetween(dueDate, asOf);
  if (age <= 30) return '0-30';
  if (age <= 60) return '31-60';
  if (age <= 90) return '61-90';
  return '90+';
}

/** Age a set of open items as of a date. Zero-outstanding items are ignored. */
export function ageDebtors(items: readonly OpenItem[], asOf: string, currency = 'USD'): AgeingBuckets {
  const buckets: Record<AgeingBand, Money> = {
    '0-30': zero(currency),
    '31-60': zero(currency),
    '61-90': zero(currency),
    '90+': zero(currency),
  };
  for (const it of items) {
    if (it.outstandingMinor === 0) continue;
    const band = bandFor(it.dueDate, asOf);
    buckets[band] = add(buckets[band], money(it.outstandingMinor, it.currency));
  }
  return buckets;
}

export function ageingTotal(buckets: AgeingBuckets, currency = 'USD'): Money {
  return (['0-30', '31-60', '61-90', '90+'] as const).reduce((acc, b) => add(acc, buckets[b]), zero(currency));
}

/** The ageing total must equal the AR control-account balance (BIL-008 reconciliation). */
export function reconcilesToControl(buckets: AgeingBuckets, controlBalance: Money): boolean {
  const total = ageingTotal(buckets, controlBalance.currency);
  return total.currency === controlBalance.currency && total.minor === controlBalance.minor;
}
