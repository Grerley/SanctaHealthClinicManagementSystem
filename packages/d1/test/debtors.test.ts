/**
 * Debtor ageing + collection work queue on D1 (BIL-008). Runs on real SQLite.
 * Proves: outstanding is derived from invoice lines minus allocations, aged into
 * bands by as-of date, rolled up into a per-patient work queue oldest-band-first,
 * and reconciled to the patient AR control account from the journals.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ageingReport } from '../src/debtors.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'debt-p1';

async function invoiceWithAr(id: string, patientId: string, minor: number, finalisedAt: string): Promise<void> {
  await db.prepare(`INSERT INTO billing_invoice (id, invoice_number, patient_id, status, finalised_at, created_at) VALUES (?,?,?, 'finalised', ?, ?)`).bind(id, 'INV-' + id, patientId, finalisedAt, finalisedAt).run();
  await db.prepare(`INSERT INTO billing_invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, tax_minor) VALUES (?,?,?,?,?,?,?)`).bind('l-' + id, id, 'X', 1, minor, minor, 0).run();
  // Matching AR control posting so the report reconciles to the ledger.
  await db.prepare(`INSERT INTO finance_journal_batch (id, origin, source_type, source_id, currency, posting_date, period_id) VALUES (?,?,?,?,?,?,?)`).bind('b-' + id, 'system', 'invoice', id, 'USD', finalisedAt.slice(0, 10), finalisedAt.slice(0, 7)).run();
  await db.prepare(`INSERT INTO finance_journal_line (id, batch_id, account_code, debit_minor, credit_minor) VALUES (?,?,?,?,?)`).bind('jl-' + id, 'b-' + id, '1200-PATIENT-AR', minor, 0).run();
}

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'MRN-D1', 'Sam', 'Rivers').run();
  await db.prepare(`INSERT OR IGNORE INTO finance_financial_period (id, status) VALUES ('2026-05','open')`).run();
  await db.prepare(`INSERT OR IGNORE INTO finance_financial_period (id, status) VALUES ('2026-07','open')`).run();
});

test('outstanding is aged, rolled up per patient, and reconciles to AR control', async () => {
  await invoiceWithAr('recent', PID, 3000, '2026-07-10T00:00:00Z'); // ~0-30 as of mid-July
  await invoiceWithAr('old', PID, 5000, '2026-05-01T00:00:00Z');    // 61-90+ band
  const rep = await ageingReport(db, '2026-07-20');
  assert.equal(rep.totalMinor, 8000);
  assert.equal(rep.arControlMinor, 8000);
  assert.equal(rep.reconciles, true);
  assert.equal(rep.workQueue.length, 1);
  assert.equal(rep.workQueue[0]?.patientId, PID);
  assert.equal(rep.workQueue[0]?.outstandingMinor, 8000);
  assert.equal(rep.workQueue[0]?.name, 'Rivers, Sam');
  // The oldest band drives the queue ordering (May 1 → Jul 20 is ~80 days).
  assert.equal(rep.workQueue[0]?.oldestBand, '61-90');
});

test('a report diverging from the ledger is surfaced, never hidden', async () => {
  await invoiceWithAr('one', PID, 4000, '2026-07-10T00:00:00Z');
  // Add an extra AR debit not backed by an open invoice line → totals disagree.
  await db.prepare(`INSERT INTO finance_journal_batch (id, origin, source_type, source_id, currency, posting_date, period_id) VALUES ('bx','system','manual','x','USD','2026-07-10','2026-07')`).run();
  await db.prepare(`INSERT INTO finance_journal_line (id, batch_id, account_code, debit_minor, credit_minor) VALUES ('jlx','bx','1200-PATIENT-AR',999,0)`).run();
  const rep = await ageingReport(db, '2026-07-20');
  assert.equal(rep.totalMinor, 4000);
  assert.equal(rep.arControlMinor, 4999);
  assert.equal(rep.reconciles, false);
});
