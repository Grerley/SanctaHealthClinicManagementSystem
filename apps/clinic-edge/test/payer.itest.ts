/**
 * Payer coverage, pre-auth & claims (BIL-011, optional) against real PostgreSQL.
 * Proves: eligibility reflects active coverage; pre-auth has a decision lifecycle;
 * a claim is raised against an invoice and a PAID claim settles through the ledger
 * (the invoice balance drops), while a rejected claim leaves the balance with the
 * patient.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { doCheckout } from '../src/api.ts';
import { invoiceOutstanding } from '../src/billing.ts';
import { registerPayer, addCoverage, checkEligibility, requestPreauth, decidePreauth, submitClaim, adjudicateClaim, PayerError } from '../src/payer.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
let PAYER: string;
let COVERAGE: string;
let INVOICE: string;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
  // A charge with only part paid → an outstanding balance to claim.
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 1500, paymentMinor: 500, paymentMethod: 'cash' });
  INVOICE = (await pool.query(`SELECT id FROM billing.invoice WHERE patient_id=$1 LIMIT 1`, [PATIENT])).rows[0].id;
  PAYER = (await registerPayer(pool, { code: 'NHIF', name: 'National Health Insurance Fund' })).id;
  COVERAGE = (await addCoverage(pool, { patientId: PATIENT, payerId: PAYER, memberNumber: 'M-123', plan: 'Standard', effectiveFrom: '2026-01-01' })).id;
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('eligibility reflects active coverage as-of a date (BIL-011)', { skip }, async () => {
  const now = await checkEligibility(pool, { patientId: PATIENT, asOf: '2026-07-21' });
  assert.equal(now.eligible, true);
  assert.equal(now.coverages[0]!.coverageId, COVERAGE);

  // Before the coverage started → not eligible.
  const before2 = await checkEligibility(pool, { patientId: PATIENT, asOf: '2025-01-01' });
  assert.equal(before2.eligible, false);
});

test('pre-authorisation has a decision lifecycle (BIL-011)', { skip }, async () => {
  const pa = await requestPreauth(pool, { reference: 'PA-001', patientId: PATIENT, payerId: PAYER, serviceCode: 'CONSULT' });
  const decided = await decidePreauth(pool, { preauthId: pa.id, approve: true, authorisation: 'AUTH-999' });
  assert.equal(decided.status, 'approved');
  // Cannot decide twice.
  await assert.rejects(decidePreauth(pool, { preauthId: pa.id, approve: false }), PayerError);
});

test('a paid claim settles through the ledger; a rejected one does not (BIL-011)', { skip }, async () => {
  const outstandingBefore = await invoiceOutstanding(pool, INVOICE); // 1000 (1500 - 500 paid)
  assert.equal(outstandingBefore, 1000);

  // Claim the full outstanding; payer pays 800, disallows 200.
  const claim = await submitClaim(pool, { claimNumber: 'CLM-001', invoiceId: INVOICE, coverageId: COVERAGE });
  assert.equal(claim.submittedMinor, 1000);
  const adj = await adjudicateClaim(pool, { claimId: claim.id, accept: true, paidMinor: 800, reason: 'copay 200' });
  assert.equal(adj.status, 'paid');
  assert.equal(adj.paidMinor, 800);
  assert.equal(adj.adjustmentMinor, 200);

  // The payer payment reduced the invoice balance through the ledger.
  const outstandingAfter = await invoiceOutstanding(pool, INVOICE);
  assert.equal(outstandingAfter, 200); // 1000 - 800 paid by payer

  // The remittance is linked to a real payment.
  const rem = await pool.query(`SELECT payment_id FROM billing.claim_remittance WHERE claim_id=$1`, [claim.id]);
  assert.ok(rem.rows[0].payment_id);

  // Cannot adjudicate the same claim twice.
  await assert.rejects(adjudicateClaim(pool, { claimId: claim.id, accept: true }), PayerError);

  // A second claim for the remaining 200, rejected → balance stays with the patient.
  const claim2 = await submitClaim(pool, { claimNumber: 'CLM-002', invoiceId: INVOICE, coverageId: COVERAGE });
  assert.equal(claim2.submittedMinor, 200);
  const rej = await adjudicateClaim(pool, { claimId: claim2.id, accept: false, reason: 'not covered' });
  assert.equal(rej.status, 'rejected');
  assert.equal(await invoiceOutstanding(pool, INVOICE), 200); // unchanged — patient still owes

  // Claiming an invoice with nothing outstanding is rejected once fully settled elsewhere.
  await assert.rejects(submitClaim(pool, { claimNumber: 'CLM-003', invoiceId: INVOICE, coverageId: COVERAGE, amountMinor: 999999 }), PayerError);
});
