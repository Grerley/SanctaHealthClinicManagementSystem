import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyMarker, receiptDocument, invoiceDocument, statementDocument } from './billing-doc.ts';

const PT = { id: 'p1', name: 'A Patient', mrn: 'MRN1' };

test('the original has no copy marker; a reprint is marked COPY (BIL-007)', () => {
  assert.equal(copyMarker(1), null);
  assert.equal(copyMarker(2), 'COPY (reprint #1)');
  assert.equal(copyMarker(3), 'COPY (reprint #2)');
});

test('a receipt totals the payment and carries the reprint marker (BIL-007)', () => {
  const original = receiptDocument({ reference: 'RCPT-001', patient: PT, date: '2026-07-21', method: 'cash', amountMinor: 1500, copyNumber: 1 });
  assert.equal(original.totalMinor, 1500);
  assert.equal(original.copyMarker, null);

  const reprint = receiptDocument({ reference: 'RCPT-001', patient: PT, date: '2026-07-21', method: 'cash', amountMinor: 1500, copyNumber: 2 });
  assert.equal(reprint.copyMarker, 'COPY (reprint #1)');
});

test('invoice and statement sum their lines (BIL-007)', () => {
  const inv = invoiceDocument({ reference: 'INV-001', patient: PT, date: '2026-07-21', lines: [{ label: 'Consult', amountMinor: 1000 }, { label: 'Dressing', amountMinor: 500 }], copyNumber: 1 });
  assert.equal(inv.totalMinor, 1500);
  assert.equal(inv.kind, 'invoice');

  const stmt = statementDocument({ reference: 'STMT-001', patient: PT, date: '2026-07-21', lines: [{ label: 'Balance b/f', amountMinor: 2000 }], copyNumber: 2 });
  assert.equal(stmt.totalMinor, 2000);
  assert.equal(stmt.copyMarker, 'COPY (reprint #1)');
});
