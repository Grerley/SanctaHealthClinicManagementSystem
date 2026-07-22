/**
 * Third-party payer coverage, pre-auth & claims on D1 (BIL-011). Runs on real
 * SQLite. Proves: eligibility reflects active coverage as-of a date; a claim
 * cannot exceed the invoice outstanding; an adjudicated (paid) claim settles
 * through the normal payment path so the invoice balance drops, and a claim
 * cannot be adjudicated twice.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerPayer, addCoverage, checkEligibility, requestPreauth, decidePreauth, submitClaim, adjudicateClaim, PayerError } from '../src/payer.ts';
import { invoiceOutstanding } from '../src/billing.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'pay-p1';
const INV = 'pay-inv-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn) VALUES (?,?)`).bind(PID, 'MRN-PAY1').run();
  // A finalised invoice with 10000 minor outstanding.
  await db.prepare(`INSERT INTO billing_invoice (id, invoice_number, patient_id, status, currency, finalised_at) VALUES (?,?,?, 'finalised','USD', '2026-07-01T00:00:00Z')`)
    .bind(INV, 'INV-PAY1', PID).run();
  await db.prepare(`INSERT INTO billing_invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, tax_minor) VALUES (?,?,?,?,?,?,?)`)
    .bind('l1', INV, 'CONSULT-GP', 1, 10000, 10000, 0).run();
});

test('eligibility reflects active coverage as-of a date, primary first', async () => {
  const { id: payerId } = await registerPayer(db, { code: 'ACME', name: 'Acme Health' });
  await addCoverage(db, { patientId: PID, payerId, memberNumber: 'M-1', priority: 2, effectiveFrom: '2026-01-01' });
  await addCoverage(db, { patientId: PID, payerId, memberNumber: 'M-2', priority: 1, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' });
  const now = await checkEligibility(db, { patientId: PID, asOf: '2026-07-15' });
  assert.equal(now.eligible, true);
  assert.equal(now.coverages.length, 1); // the primary expired 2026-06-30
  assert.equal(now.coverages[0]?.memberNumber, 'M-1');
  const earlier = await checkEligibility(db, { patientId: PID, asOf: '2026-05-01' });
  assert.equal(earlier.coverages.length, 2);
  assert.equal(earlier.coverages[0]?.priority, 1); // primary first
});

test('pre-auth is decided once', async () => {
  const { id: payerId } = await registerPayer(db, { code: 'ACME', name: 'Acme Health' });
  const { id } = await requestPreauth(db, { reference: 'PA-1', patientId: PID, payerId, serviceCode: 'CONSULT-GP' });
  assert.equal((await decidePreauth(db, { preauthId: id, approve: true, authorisation: 'AUTH-9' })).status, 'approved');
  await assert.rejects(() => decidePreauth(db, { preauthId: id, approve: false }), PayerError);
});

test('a paid claim settles through the payment path and cannot be re-adjudicated', async () => {
  const { id: payerId } = await registerPayer(db, { code: 'ACME', name: 'Acme Health' });
  const { id: coverageId } = await addCoverage(db, { patientId: PID, payerId, memberNumber: 'M-1', effectiveFrom: '2026-01-01' });
  await assert.rejects(() => submitClaim(db, { claimNumber: 'C-1', invoiceId: INV, coverageId, amountMinor: 20000 }), PayerError); // exceeds outstanding
  const { id: claimId, submittedMinor } = await submitClaim(db, { claimNumber: 'C-1', invoiceId: INV, coverageId });
  assert.equal(submittedMinor, 10000);
  const res = await adjudicateClaim(db, { claimId, accept: true, paidMinor: 8000, reason: 'contracted rate', user: 'cashier1' });
  assert.equal(res.status, 'paid');
  assert.equal(res.paidMinor, 8000);
  assert.equal(res.adjustmentMinor, 2000);
  // Invoice outstanding dropped by the payer payment (10000 - 8000).
  assert.equal(await invoiceOutstanding(db, INV), 2000);
  // Double adjudication is refused.
  await assert.rejects(() => adjudicateClaim(db, { claimId, accept: true }), PayerError);
});
