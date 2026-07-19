import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money } from './money.ts';
import { isBalanced, accountBalance, assertPostable } from './ledger.ts';
import {
  ACCOUNTS,
  postInvoiceFinalised,
  postPaymentReceived,
  postDispenseCogs,
  postGoodsReceivedOnCredit,
  postRefund,
  postCashShortage,
  postBadDebtWriteOff,
  postDepreciation,
} from './posting-rules.ts';

const ctx = { batchId: 'jb-1', postingDate: '2026-07-19' };

test('every posting rule produces a balanced, postable batch (pack §8.2)', () => {
  const batches = [
    postInvoiceFinalised(ctx, 'inv-1', money(5000)),
    postPaymentReceived(ctx, 'pay-1', money(3000), 'cash'),
    postDispenseCogs(ctx, 'disp-1', money(1200)),
    postGoodsReceivedOnCredit(ctx, 'grn-1', money(8000)),
    postRefund(ctx, 'ref-1', money(500), 'mobile'),
    postCashShortage(ctx, 'shift-1', money(150)),
    postBadDebtWriteOff(ctx, 'wo-1', money(2000)),
    postDepreciation(ctx, 'dep-1', money(400)),
  ];
  for (const b of batches) {
    assert.ok(isBalanced(b), `batch from ${b.source.type} should balance`);
    assert.doesNotThrow(() => assertPostable(b));
  }
});

test('invoice finalisation debits AR and credits revenue', () => {
  const b = postInvoiceFinalised(ctx, 'inv-1', money(5000), 'medicine');
  assert.equal(accountBalance([b], ACCOUNTS.patientAR).minor, 5000);
  assert.equal(accountBalance([b], ACCOUNTS.medicineRevenue).minor, -5000);
});

test('invoice then payment clears the receivable', () => {
  const inv = postInvoiceFinalised(ctx, 'inv-2', money(5000));
  const pay = postPaymentReceived({ ...ctx, batchId: 'jb-2' }, 'pay-2', money(5000), 'bank');
  assert.equal(accountBalance([inv, pay], ACCOUNTS.patientAR).minor, 0);
  assert.equal(accountBalance([inv, pay], ACCOUNTS.bankClearing).minor, 5000);
});

test('dispense posts COGS against inventory', () => {
  const b = postDispenseCogs(ctx, 'disp-2', money(1200));
  assert.equal(accountBalance([b], ACCOUNTS.cogs).minor, 1200);
  assert.equal(accountBalance([b], ACCOUNTS.inventory).minor, -1200);
});
