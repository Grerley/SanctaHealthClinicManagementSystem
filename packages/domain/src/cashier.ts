/**
 * Cashier shift close (BIL-009, pack §8.3, UAT-09). Pure calculations for the
 * daily cash control: expected cash from the immutable payment/refund record,
 * a physical denomination count, the variance, and the approval gate above
 * tolerance. All amounts are integer minor units.
 *
 * The shift never edits payments — it reconciles against them. A variance posts a
 * cash-over/short journal (see posting-rules.postCashShortage); it is never hidden.
 */

export type Denomination = {
  /** Value of one unit in minor units, e.g. 100 = $1.00, 5000 = $50 note. */
  readonly unitMinor: number;
  /** How many of that denomination were physically counted. */
  readonly count: number;
};

export class CashierError extends Error {}

/** Total of a physical denomination count, in minor units. */
export function countTotal(denominations: readonly Denomination[]): number {
  let total = 0;
  for (const d of denominations) {
    if (d.unitMinor < 0 || d.count < 0 || !Number.isInteger(d.unitMinor) || !Number.isInteger(d.count)) {
      throw new CashierError('denomination unit and count must be non-negative integers');
    }
    total += d.unitMinor * d.count;
  }
  return total;
}

/**
 * Expected cash in the drawer at close = opening float + cash received - cash
 * refunded/paid out during the shift. Only cash movements count (card, bank and
 * mobile-money settle elsewhere).
 */
export function expectedCash(openingFloatMinor: number, cashReceiptsMinor: number, cashPayOutsMinor: number): number {
  return openingFloatMinor + cashReceiptsMinor - cashPayOutsMinor;
}

export function variance(countedMinor: number, expectedMinor: number): number {
  return countedMinor - expectedMinor;
}

export function requiresApproval(varianceMinor: number, toleranceMinor: number): boolean {
  return Math.abs(varianceMinor) > Math.abs(toleranceMinor);
}

export type ShiftCloseInput = {
  readonly openingFloatMinor: number;
  readonly cashReceiptsMinor: number;
  readonly cashPayOutsMinor: number;
  readonly denominations: readonly Denomination[];
  readonly toleranceMinor: number;
};

export type ShiftCloseResult = {
  readonly countedMinor: number;
  readonly expectedMinor: number;
  readonly varianceMinor: number;
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  /** Always 'closed' on a successful return; over-tolerance without an approver throws. */
  readonly status: 'closed';
};

/**
 * Compute a shift close. If the variance exceeds tolerance, closure is only
 * permitted with a supervisor approver (BIL-009: "cannot close with unresolved
 * variance above tolerance"). Throws when approval is required but absent.
 */
export function closeShift(input: ShiftCloseInput, opts: { approver?: string } = {}): ShiftCloseResult {
  const countedMinor = countTotal(input.denominations);
  const expectedMinor = expectedCash(input.openingFloatMinor, input.cashReceiptsMinor, input.cashPayOutsMinor);
  const varianceMinor = variance(countedMinor, expectedMinor);
  const needsApproval = requiresApproval(varianceMinor, input.toleranceMinor);

  if (needsApproval && !opts.approver) {
    throw new CashierError(
      `variance ${varianceMinor} exceeds tolerance ${input.toleranceMinor}; supervisor approval required to close`,
    );
  }

  return {
    countedMinor,
    expectedMinor,
    varianceMinor,
    requiresApproval: needsApproval,
    approved: needsApproval ? Boolean(opts.approver) : false,
    status: 'closed',
  };
}
