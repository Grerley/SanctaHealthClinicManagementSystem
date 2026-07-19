/**
 * Effective-dated fee schedule / price book (BIL-001, BR-005, pack §8.3).
 *
 * The price applied to an invoice is resolved by the effective date, and the
 * invoice retains the applied rule VERSION so historical invoices never change
 * when prices are updated later.
 */
import { type Money, money } from './money.ts';

export type FeeVersion = {
  readonly serviceCode: string;
  readonly version: number;
  readonly effectiveFrom: string; // ISO date, inclusive
  readonly effectiveTo?: string; // ISO date, exclusive; open-ended if absent
  readonly standardMinor: number;
  readonly minMinor: number;
  readonly maxMinor: number;
  readonly taxRateBps?: number; // basis points, e.g. 1500 = 15%
  readonly currency: string;
};

export class PriceError extends Error {}

function isEffective(v: FeeVersion, onDate: string): boolean {
  if (onDate < v.effectiveFrom) return false;
  if (v.effectiveTo !== undefined && onDate >= v.effectiveTo) return false;
  return true;
}

/** Resolve the fee version effective on a date. Throws if none applies. */
export function resolveFee(schedule: readonly FeeVersion[], serviceCode: string, onDate: string): FeeVersion {
  const candidates = schedule
    .filter((v) => v.serviceCode === serviceCode && isEffective(v, onDate))
    .sort((a, b) => b.version - a.version);
  const found = candidates[0];
  if (!found) throw new PriceError(`no effective fee for ${serviceCode} on ${onDate}`);
  return found;
}

export type AppliedPrice = {
  readonly serviceCode: string;
  readonly ruleVersion: number;
  readonly standard: Money;
  readonly applied: Money;
  readonly adjustment: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly reason?: string;
  readonly approver?: string;
};

/**
 * Compute an applied price line. An override outside [min,max] requires a reason
 * and an approver (BIL-003, segregation via caller). Standard price and applied
 * price are both retained (pack §8.3).
 */
export function applyPrice(
  fee: FeeVersion,
  opts: { appliedMinor?: number; reason?: string; approver?: string } = {},
): AppliedPrice {
  const appliedMinor = opts.appliedMinor ?? fee.standardMinor;
  const outOfBand = appliedMinor < fee.minMinor || appliedMinor > fee.maxMinor;
  if (appliedMinor !== fee.standardMinor) {
    if (!opts.reason) throw new PriceError('price override requires a reason (BIL-003)');
  }
  if (outOfBand && !opts.approver) {
    throw new PriceError('price outside min/max band requires an approver (BIL-003)');
  }
  const standard = money(fee.standardMinor, fee.currency);
  const applied = money(appliedMinor, fee.currency);
  const adjustment = money(appliedMinor - fee.standardMinor, fee.currency);
  const taxMinor = fee.taxRateBps ? Math.round((appliedMinor * fee.taxRateBps) / 10_000) : 0;
  const tax = money(taxMinor, fee.currency);
  const total = money(appliedMinor + taxMinor, fee.currency);
  return {
    serviceCode: fee.serviceCode,
    ruleVersion: fee.version,
    standard,
    applied,
    adjustment,
    tax,
    total,
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    ...(opts.approver === undefined ? {} : { approver: opts.approver }),
  };
}
