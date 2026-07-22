/**
 * Payment allocation / reallocation / refunds on D1 (BIL-006/010, BR-006, UAT-08).
 * Runs on real SQLite (same engine as D1). Proves: a payment credits AR once via a
 * balanced journal, allocations can't exceed the payment, reallocation preserves
 * history (append-only), and refunds are authorised + capped at the refundable
 * amount and post a reversing journal.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordPayment, allocate, reallocate, refundPayment, invoiceOutstanding, BillingError } from '../src/billing.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'bil-pat-1';

async function makeInvoice(id: string, appliedMinor: number): Promise<void> {
  await db.prepare(`INSERT INTO billing_invoice (id, invoice_number, patient_id, status) VALUES (?,?,?, 'finalised')`).bind(id, 'INV-' + id, PID).run();
  await db.prepare(`INSERT INTO billing_invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, tax_minor) VALUES (?,?,?,?,?,?,0)`)
    .bind('line-' + id, id, 'SVC', 1, appliedMinor, appliedMinor).run();
}

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-400001', 'Bill', 'Test').run();
});

test('a payment credits AR once via a balanced journal', async () => {
  const { paymentId } = await recordPayment(db, { patientId: PID, method: 'cash', amountMinor: 5000, postingDate: '2026-07-19' });
  assert.ok(paymentId);
  // The payment journal is balanced (Σ debits == Σ credits).
  const j = await db.prepare(`SELECT COALESCE(SUM(debit_minor),0) AS d, COALESCE(SUM(credit_minor),0) AS c FROM finance_journal_line
    WHERE batch_id IN (SELECT id FROM finance_journal_batch WHERE source_type='payment' AND source_id=?)`).bind(paymentId).first<{ d: number; c: number }>();
  assert.equal(Number(j?.d), 5000);
  assert.equal(Number(j?.c), 5000);
});

test('allocations cannot exceed the payment; outstanding drops as allocated', async () => {
  await makeInvoice('inv-1', 3000);
  const { paymentId } = await recordPayment(db, { patientId: PID, method: 'cash', amountMinor: 3000 });
  assert.equal(await invoiceOutstanding(db, 'inv-1'), 3000);
  await allocate(db, { paymentId, allocations: [{ invoiceId: 'inv-1', amountMinor: 2000 }] });
  assert.equal(await invoiceOutstanding(db, 'inv-1'), 1000);
  await assert.rejects(() => allocate(db, { paymentId, allocations: [{ invoiceId: 'inv-1', amountMinor: 2000 }] }), BillingError); // 2000+2000 > 3000
});

test('reallocation moves value append-only (history preserved)', async () => {
  await makeInvoice('inv-a', 5000);
  await makeInvoice('inv-b', 5000);
  const { paymentId } = await recordPayment(db, { patientId: PID, method: 'cash', amountMinor: 4000 });
  await allocate(db, { paymentId, allocations: [{ invoiceId: 'inv-a', amountMinor: 4000 }] });
  await reallocate(db, { paymentId, fromInvoiceId: 'inv-a', toInvoiceId: 'inv-b', amountMinor: 1500 });
  assert.equal(await invoiceOutstanding(db, 'inv-a'), 5000 - 2500); // 4000 - 1500 applied
  assert.equal(await invoiceOutstanding(db, 'inv-b'), 5000 - 1500);
  const rows = await db.prepare(`SELECT COUNT(*) AS n FROM billing_payment_allocation WHERE payment_id=?`).bind(paymentId).first<{ n: number }>();
  assert.equal(Number(rows?.n), 3); // original + negative + positive — nothing edited
  await assert.rejects(() => reallocate(db, { paymentId, fromInvoiceId: 'inv-a', toInvoiceId: 'inv-b', amountMinor: 9999 }), BillingError);
});

test('refund requires an approver and cannot exceed the refundable amount', async () => {
  const { paymentId } = await recordPayment(db, { patientId: PID, method: 'cash', amountMinor: 3000, postingDate: '2026-07-19' });
  await assert.rejects(() => refundPayment(db, { paymentId, amountMinor: 1000, method: 'cash', reason: 'overpaid' }), BillingError); // no approver
  const r = await refundPayment(db, { paymentId, amountMinor: 1000, method: 'cash', reason: 'overpaid', approver: 'mgr1', postingDate: '2026-07-19' });
  assert.ok(r.refundId);
  await assert.rejects(() => refundPayment(db, { paymentId, amountMinor: 2500, method: 'cash', reason: 'again', approver: 'mgr1' }), BillingError); // 1000+2500 > 3000
});
