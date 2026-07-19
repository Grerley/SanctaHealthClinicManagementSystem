/**
 * Double-entry ledger primitives (FIN-002, BR-009, pack §8).
 *
 * Invariants enforced here (in the trusted layer, never the UI):
 *  - every journal batch balances: Σ debits == Σ credits, per currency;
 *  - a batch always carries a source reference (existence, pack §8.1);
 *  - system-generated batches are immutable — they can only be reversed by
 *    generating a linked counter-batch, never edited (BR-009).
 */
import { type Money, add, zero, isZero, negate } from './money.ts';

export type NormalSide = 'debit' | 'credit';

export type JournalLine = {
  readonly accountCode: string;
  /** Positive Money on the debit side. */
  readonly debit: Money;
  /** Positive Money on the credit side. */
  readonly credit: Money;
  readonly costCentre?: string;
  readonly memo?: string;
};

export type JournalOrigin = 'system' | 'manual';

export type JournalBatch = {
  readonly id: string;
  readonly origin: JournalOrigin;
  /** Source document reference — required (pack §8.1 existence). */
  readonly source: { readonly type: string; readonly id: string };
  readonly currency: string;
  readonly postingDate: string; // ISO date
  readonly lines: readonly JournalLine[];
  /** Set when this batch reverses another; makes reversal auditable. */
  readonly reverses?: string;
};

export class LedgerError extends Error {}

export function debitTotal(batch: JournalBatch): Money {
  return batch.lines.reduce((acc, l) => add(acc, l.debit), zero(batch.currency));
}

export function creditTotal(batch: JournalBatch): Money {
  return batch.lines.reduce((acc, l) => add(acc, l.credit), zero(batch.currency));
}

export function isBalanced(batch: JournalBatch): boolean {
  const d = debitTotal(batch);
  const c = creditTotal(batch);
  return d.currency === c.currency && d.minor === c.minor;
}

/**
 * Validate a batch before it may be posted. Throws LedgerError on any violation.
 * This is the single choke point every posting must pass (system or manual).
 */
export function assertPostable(batch: JournalBatch): void {
  if (batch.lines.length === 0) {
    throw new LedgerError(`batch ${batch.id} has no lines`);
  }
  if (!batch.source || !batch.source.type || !batch.source.id) {
    throw new LedgerError(`batch ${batch.id} has no source reference`);
  }
  for (const l of batch.lines) {
    if (l.debit.minor < 0 || l.credit.minor < 0) {
      throw new LedgerError(`negative amounts are not allowed on line ${l.accountCode}`);
    }
    if (l.debit.minor > 0 && l.credit.minor > 0) {
      throw new LedgerError(`line ${l.accountCode} cannot be both debit and credit`);
    }
    if (l.debit.currency !== batch.currency || l.credit.currency !== batch.currency) {
      throw new LedgerError(`line ${l.accountCode} currency differs from batch`);
    }
  }
  if (!isBalanced(batch)) {
    throw new LedgerError(
      `batch ${batch.id} is unbalanced: debit ${debitTotal(batch).minor} != credit ${creditTotal(batch).minor}`,
    );
  }
}

/**
 * Produce the linked reversing batch for an existing batch (BR-009). The
 * original is never mutated. Debits and credits are swapped.
 */
export function reverse(batch: JournalBatch, reversalId: string, postingDate: string): JournalBatch {
  return {
    id: reversalId,
    origin: batch.origin,
    source: batch.source,
    currency: batch.currency,
    postingDate,
    reverses: batch.id,
    lines: batch.lines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.credit,
      credit: l.debit,
      ...(l.costCentre === undefined ? {} : { costCentre: l.costCentre }),
      ...(l.memo === undefined ? {} : { memo: `reversal: ${l.memo}` }),
    })),
  };
}

/** Net balance of an account across posted batches, using debit-positive sign. */
export function accountBalance(
  batches: readonly JournalBatch[],
  accountCode: string,
  currency = 'USD',
): Money {
  let bal = zero(currency);
  for (const b of batches) {
    for (const l of b.lines) {
      if (l.accountCode !== accountCode) continue;
      bal = add(bal, l.debit);
      bal = add(bal, negate(l.credit));
    }
  }
  return bal;
}

/** A trial balance across every account must itself net to zero (isZero). */
export function trialBalanceNet(batches: readonly JournalBatch[], currency = 'USD'): Money {
  let net = zero(currency);
  for (const b of batches) {
    net = add(net, debitTotal(b));
    net = add(net, negate(creditTotal(b)));
  }
  return net;
}

export function trialBalances(batches: readonly JournalBatch[]): boolean {
  return isZero(trialBalanceNet(batches));
}
