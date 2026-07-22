/**
 * Print/reprint on D1 (BIL-007). Runs on real SQLite. Proves: the first print is
 * the original (copy 1, no COPY marker) and a reprint increments the copy number
 * and is marked a COPY; an invoice statement lists only outstanding invoices.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { printReceipt, printInvoice, printStatement, BillingPrintError } from '../src/billing-print.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'bp-p1';
const INV = 'bp-inv-1';
const PAY = 'bp-pay-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'MRN-BP1', 'Ada', 'Lovelace').run();
  await db.prepare(`INSERT INTO billing_invoice (id, invoice_number, patient_id, status, currency, finalised_at) VALUES (?,?,?, 'finalised','USD','2026-07-01T00:00:00Z')`).bind(INV, 'INV-BP1', PID).run();
  await db.prepare(`INSERT INTO billing_invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, tax_minor) VALUES (?,?,?,?,?,?,?)`).bind('bl1', INV, 'CONSULT-GP', 1, 5000, 5000, 750).run();
  await db.prepare(`INSERT INTO billing_payment (id, receipt_number, patient_id, method, amount_minor, received_at) VALUES (?,?,?,?,?,?)`).bind(PAY, 'RCT-BP1', PID, 'cash', 5750, '2026-07-01T10:00:00Z').run();
});

test('first receipt print is the original; a reprint is marked a COPY', async () => {
  const original = await printReceipt(db, { paymentId: PAY, printedBy: 'cashier1' });
  assert.equal(original.copyNumber, 1);
  assert.equal(original.copyMarker, null); // original carries no COPY marker
  const reprint = await printReceipt(db, { paymentId: PAY, printedBy: 'cashier1' });
  assert.equal(reprint.copyNumber, 2);
  assert.equal(reprint.copyMarker, 'COPY (reprint #1)');
  const count = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM billing_document_print WHERE kind='receipt' AND ref_id=?`, [PAY]);
  assert.equal(count?.n, 2);
});

test('invoice print carries the priced lines', async () => {
  const doc = await printInvoice(db, { invoiceId: INV, printedBy: 'reception1' });
  assert.equal(doc.copyNumber, 1);
  assert.equal(doc.lines.length, 1);
  assert.equal(doc.lines[0]?.amountMinor, 5750); // applied 5000 + tax 750
});

test('statement lists only outstanding invoices', async () => {
  const doc = await printStatement(db, { patientId: PID, date: '2026-07-20', printedBy: 'reception1' });
  assert.equal(doc.lines.length, 1); // the one unpaid invoice
  // Fully allocate the invoice, then it drops off the statement.
  await db.prepare(`INSERT INTO billing_payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES (?,?,?,?)`).bind('alloc1', PAY, INV, 5750).run();
  const doc2 = await printStatement(db, { patientId: PID, date: '2026-07-20', printedBy: 'reception1' });
  assert.equal(doc2.lines.length, 0);
  await assert.rejects(() => printStatement(db, { patientId: 'nope' }), BillingPrintError);
});
