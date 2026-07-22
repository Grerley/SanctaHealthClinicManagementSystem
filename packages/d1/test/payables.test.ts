/**
 * Expenses & accounts payable on D1 (FIN-005/006, UAT-12). Runs on real SQLite
 * (same engine as D1). Proves: an approved expense creates a payable and posts to
 * AP, paying settles it (once), and the AP subledger reconciles to the GL control
 * account throughout.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordExpense, paySupplier, apReconciliation, PayableError } from '../src/payables.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('an expense requires an approver and a positive amount', async () => {
  await assert.rejects(() => recordExpense(db, { category: 'rent', amountMinor: 1000 }), PayableError);
  await assert.rejects(() => recordExpense(db, { category: 'rent', amountMinor: 0, approver: 'mgr' }), PayableError);
});

test('expense -> payable -> pay, with AP reconciling to the ledger throughout', async () => {
  const { payableId } = await recordExpense(db, { category: 'rent', supplier: 'Landlord', amountMinor: 30000, approver: 'mgr', postingDate: '2026-07-19' });
  let rec = await apReconciliation(db);
  assert.equal(rec.subledgerMinor, 30000);
  assert.equal(rec.controlMinor, 30000);   // Cr supplier-AP posted
  assert.equal(rec.reconciles, true);

  const paid = await paySupplier(db, { payableId, method: 'cash', postingDate: '2026-07-19' });
  assert.equal(paid.paidMinor, 30000);
  rec = await apReconciliation(db);
  assert.equal(rec.subledgerMinor, 0);     // payable settled
  assert.equal(rec.controlMinor, 0);       // Dr AP nets the control to zero
  assert.equal(rec.reconciles, true);

  await assert.rejects(() => paySupplier(db, { payableId }), PayableError); // already settled
});
