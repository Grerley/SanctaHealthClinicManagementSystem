/**
 * Effective-dated pricing on D1 (BIL-001, BIL-003). Runs on real SQLite (same
 * engine as D1). Proves: the fee effective on a date is resolved and priced;
 * an override away from standard needs a reason and out-of-band needs an approver;
 * charging a service finalises an invoice retaining the applied rule version and
 * posts a balanced Dr AR / Cr Revenue / Cr Tax journal; a new fee version closes
 * the prior so old invoices keep their historical price.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { quotePrice, chargeService, defineFee, listFees, PricingError } from '../src/pricing.ts';
import { PriceError } from '@sancta/domain';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'demo-patient-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  // A patient the invoice can FK to.
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`)
    .bind(PID, 'MRN-P1', 'Test', 'Patient').run();
});

test('quote resolves the effective fee and prices standard', async () => {
  const q = await quotePrice(db, { serviceCode: 'CONSULT-GP', onDate: '2026-07-01' });
  assert.equal(q.ruleVersion, 1);
  assert.equal(q.standard.minor, 5000);
  assert.equal(q.applied.minor, 5000);
  assert.equal(q.tax.minor, 750); // 15% of 5000
  assert.equal(q.total.minor, 5750);
});

test('override away from standard needs a reason; out-of-band needs an approver', async () => {
  await assert.rejects(() => quotePrice(db, { serviceCode: 'CONSULT-GP', onDate: '2026-07-01', appliedMinor: 4500 }), PriceError);
  // In-band with a reason is fine.
  const ok = await quotePrice(db, { serviceCode: 'CONSULT-GP', onDate: '2026-07-01', appliedMinor: 4500, reason: 'goodwill' });
  assert.equal(ok.applied.minor, 4500);
  // Out-of-band (below min 4000) needs an approver even with a reason.
  await assert.rejects(() => quotePrice(db, { serviceCode: 'CONSULT-GP', onDate: '2026-07-01', appliedMinor: 3000, reason: 'hardship' }), PriceError);
  const capped = await quotePrice(db, { serviceCode: 'CONSULT-GP', onDate: '2026-07-01', appliedMinor: 3000, reason: 'hardship', approver: 'supervisor1' });
  assert.equal(capped.applied.minor, 3000);
});

test('charging a service finalises an invoice and posts a balanced journal', async () => {
  const res = await chargeService(db, { patientId: PID, serviceCode: 'CONSULT-GP', onDate: '2026-07-01', user: 'reception1' });
  assert.equal(res.totalMinor, 5750);
  const inv = await one<{ status: string }>(db, `SELECT status FROM billing_invoice WHERE id=?`, [res.invoiceId]);
  assert.equal(inv?.status, 'finalised');
  const line = await one<{ rule_version: number; applied_minor: number; tax_minor: number }>(db, `SELECT rule_version, applied_minor, tax_minor FROM billing_invoice_line WHERE invoice_id=?`, [res.invoiceId]);
  assert.equal(line?.rule_version, 1);
  assert.equal(line?.applied_minor, 5000);
  assert.equal(line?.tax_minor, 750);
  // Journal balances: Σdebit == Σcredit == 5750.
  const bal = await one<{ d: number; c: number }>(db,
    `SELECT COALESCE(SUM(debit_minor),0) AS d, COALESCE(SUM(credit_minor),0) AS c
     FROM finance_journal_line l JOIN finance_journal_batch b ON b.id=l.batch_id WHERE b.source_id=?`, [res.invoiceId]);
  assert.equal(bal?.d, 5750);
  assert.equal(bal?.c, 5750);
});

test('a new fee version closes the prior; old dates keep the old price', async () => {
  await defineFee(db, { serviceCode: 'CONSULT-GP', effectiveFrom: '2026-08-01', standardMinor: 6000, minMinor: 5000, maxMinor: 9000, taxRateBps: 1500 });
  const before = await quotePrice(db, { serviceCode: 'CONSULT-GP', onDate: '2026-07-15' });
  assert.equal(before.ruleVersion, 1);
  assert.equal(before.standard.minor, 5000);
  const after = await quotePrice(db, { serviceCode: 'CONSULT-GP', onDate: '2026-08-15' });
  assert.equal(after.ruleVersion, 2);
  assert.equal(after.standard.minor, 6000);
  // A backdated version is rejected.
  await assert.rejects(() => defineFee(db, { serviceCode: 'CONSULT-GP', effectiveFrom: '2026-07-01', standardMinor: 7000, minMinor: 6000, maxMinor: 9000 }), PricingError);
  // Bad band is rejected.
  await assert.rejects(() => defineFee(db, { serviceCode: 'X', effectiveFrom: '2026-01-01', standardMinor: 100, minMinor: 200, maxMinor: 300 }), PricingError);
  assert.equal((await listFees(db, 'CONSULT-GP')).length, 2);
});
