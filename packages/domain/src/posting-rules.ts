/**
 * Posting rules: turn business events into balanced double-entry journal batches
 * (pack §8.2). Every rule returns a JournalBatch that passes `assertPostable`.
 *
 * Account codes here are illustrative defaults; the real chart of accounts is
 * effective-dated configuration (FIN-001) resolved at posting time.
 */
import { type Money } from './money.ts';
import { type JournalBatch, assertPostable } from './ledger.ts';

export const ACCOUNTS = {
  cash: '1000-CASH',
  bankClearing: '1010-BANK-CLEARING',
  mobileMoneyClearing: '1020-MM-CLEARING',
  patientAR: '1200-PATIENT-AR',
  inventory: '1300-INVENTORY',
  fixedAsset: '1500-FIXED-ASSET',
  accumDepreciation: '1590-ACCUM-DEPR',
  supplierAP: '2100-SUPPLIER-AP',
  depositLiability: '2200-PATIENT-DEPOSIT',
  serviceRevenue: '4000-SERVICE-REVENUE',
  medicineRevenue: '4010-MEDICINE-REVENUE',
  cogs: '5000-COGS',
  suppliesExpense: '5100-SUPPLIES-EXPENSE',
  operatingExpense: '6000-OPERATING-EXPENSE',
  depreciationExpense: '6100-DEPRECIATION-EXPENSE',
  cashOverShort: '6900-CASH-OVER-SHORT',
  badDebtExpense: '6910-BAD-DEBT',
} as const;

type Source = { readonly type: string; readonly id: string };

function twoLine(
  id: string,
  source: Source,
  postingDate: string,
  debitAccount: string,
  creditAccount: string,
  amount: Money,
): JournalBatch {
  const batch: JournalBatch = {
    id,
    origin: 'system',
    source,
    currency: amount.currency,
    postingDate,
    lines: [
      { accountCode: debitAccount, debit: amount, credit: { minor: 0, currency: amount.currency } },
      { accountCode: creditAccount, debit: { minor: 0, currency: amount.currency }, credit: amount },
    ],
  };
  assertPostable(batch);
  return batch;
}

export type PostingContext = {
  readonly batchId: string;
  readonly postingDate: string;
};

/** Finalise patient invoice: Dr Patient AR / Cr Revenue (service or medicine). */
export function postInvoiceFinalised(
  ctx: PostingContext,
  invoiceId: string,
  amount: Money,
  kind: 'service' | 'medicine' = 'service',
): JournalBatch {
  return twoLine(
    ctx.batchId,
    { type: 'invoice', id: invoiceId },
    ctx.postingDate,
    ACCOUNTS.patientAR,
    kind === 'service' ? ACCOUNTS.serviceRevenue : ACCOUNTS.medicineRevenue,
    amount,
  );
}

/** Receive patient payment: Dr Cash/Bank/MM clearing / Cr Patient AR. */
export function postPaymentReceived(
  ctx: PostingContext,
  paymentId: string,
  amount: Money,
  method: 'cash' | 'bank' | 'mobile',
): JournalBatch {
  const debit =
    method === 'cash' ? ACCOUNTS.cash : method === 'bank' ? ACCOUNTS.bankClearing : ACCOUNTS.mobileMoneyClearing;
  return twoLine(ctx.batchId, { type: 'payment', id: paymentId }, ctx.postingDate, debit, ACCOUNTS.patientAR, amount);
}

/** Dispense or consume stock: Dr COGS / Cr Inventory (BR-008 component). */
export function postDispenseCogs(ctx: PostingContext, dispenseId: string, cost: Money): JournalBatch {
  return twoLine(ctx.batchId, { type: 'dispense', id: dispenseId }, ctx.postingDate, ACCOUNTS.cogs, ACCOUNTS.inventory, cost);
}

/** Receive inventory on credit: Dr Inventory / Cr Supplier AP. */
export function postGoodsReceivedOnCredit(ctx: PostingContext, grnId: string, cost: Money): JournalBatch {
  return twoLine(ctx.batchId, { type: 'goods-receipt', id: grnId }, ctx.postingDate, ACCOUNTS.inventory, ACCOUNTS.supplierAP, cost);
}

/** Refund: Dr Revenue reversal / Cr Cash (linked to an approved receipt). */
export function postRefund(ctx: PostingContext, refundId: string, amount: Money, method: 'cash' | 'bank' | 'mobile'): JournalBatch {
  const credit =
    method === 'cash' ? ACCOUNTS.cash : method === 'bank' ? ACCOUNTS.bankClearing : ACCOUNTS.mobileMoneyClearing;
  return twoLine(ctx.batchId, { type: 'refund', id: refundId }, ctx.postingDate, ACCOUNTS.serviceRevenue, credit, amount);
}

/** Cashier shortage: Dr Cash over/short / Cr Cash drawer. */
export function postCashShortage(ctx: PostingContext, shiftId: string, amount: Money): JournalBatch {
  return twoLine(ctx.batchId, { type: 'cashier-shift', id: shiftId }, ctx.postingDate, ACCOUNTS.cashOverShort, ACCOUNTS.cash, amount);
}

/** Bad debt write-off: Dr Bad debt expense / Cr Patient AR (approved). */
export function postBadDebtWriteOff(ctx: PostingContext, writeOffId: string, amount: Money): JournalBatch {
  return twoLine(ctx.batchId, { type: 'write-off', id: writeOffId }, ctx.postingDate, ACCOUNTS.badDebtExpense, ACCOUNTS.patientAR, amount);
}

/** Depreciation: Dr Depreciation expense / Cr Accumulated depreciation. */
export function postDepreciation(ctx: PostingContext, runId: string, amount: Money): JournalBatch {
  return twoLine(ctx.batchId, { type: 'depreciation-run', id: runId }, ctx.postingDate, ACCOUNTS.depreciationExpense, ACCOUNTS.accumDepreciation, amount);
}
