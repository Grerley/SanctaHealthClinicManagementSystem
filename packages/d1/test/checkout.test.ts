/**
 * The dispense-and-pay checkout on D1 — the app's hardest transaction. Proves on
 * real SQLite that the single atomic batch() preserves every invariant the
 * Postgres version did: money correctness (balanced double-entry), all-or-nothing
 * atomicity, idempotent replay, and full rollback on insufficient stock — WITHOUT
 * a database lock.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { receiveStock, commitCheckoutD1, DuplicateCheckoutError } from '../src/index.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { StockError } from '@sancta/domain';
import type { LocalD1 } from '../src/d1.ts';

const SKU = 'AMOX-500';
const PATIENT = 'pat-1';
let db: LocalD1;

function req(overrides: Partial<{ quantity: number; charge: number; payment: number; enc: string; inv: string }> = {}) {
  return {
    dispense: {
      sku: SKU, quantity: overrides.quantity ?? 10, patientId: PATIENT,
      encounterId: overrides.enc ?? 'enc-1', invoiceId: overrides.inv ?? 'inv-1',
      chargeMinor: overrides.charge ?? 1500, asOfDate: '2026-07-19', postingDate: '2026-07-19',
      location: 'MAIN', device: 'dev-1', user: 'user-1', site: 'site-1',
    },
    paymentMinor: overrides.payment ?? 500,
    paymentMethod: 'cash' as const,
    now: 1_700_000_000_000,
  };
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.prepare(sql).bind(...params).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PATIENT, 'SCC-1', 'Test', 'Patient').run();
  await receiveStock(db, { sku: SKU, lotId: 'lot-1', expiryDate: '2027-01-01', unitCostMinor: 12, location: 'MAIN', quantity: 100 });
});

test('a checkout commits stock, invoice, payment and a balanced ledger atomically (BR-008)', async () => {
  const out = await commitCheckoutD1(db, req());
  assert.equal(out.cogsMinor, 10 * 12); // 10 units @ 12

  // Stock decremented.
  assert.equal(await scalar(`SELECT COALESCE(SUM(on_hand),0) AS n FROM inventory_stock_balance WHERE sku=?`, [SKU]), 90);
  // Invoice + line + payment + allocation exist.
  assert.equal(await scalar(`SELECT count(*) AS n FROM billing_invoice WHERE id='inv-1' AND status='finalised'`), 1);
  assert.equal(await scalar(`SELECT count(*) AS n FROM billing_invoice_line WHERE invoice_id='inv-1'`), 1);
  assert.equal(await scalar(`SELECT count(*) AS n FROM billing_payment WHERE patient_id=?`, [PATIENT]), 1);
  assert.equal(await scalar(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM billing_payment_allocation WHERE invoice_id='inv-1'`), 500);

  // The ledger is balanced: Σ debits == Σ credits across all posted journal lines (double-entry).
  const debits = await scalar(`SELECT COALESCE(SUM(debit_minor),0) AS n FROM finance_journal_line`);
  const credits = await scalar(`SELECT COALESCE(SUM(credit_minor),0) AS n FROM finance_journal_line`);
  assert.equal(debits, credits);
  // Three balanced batches were posted (revenue, COGS, payment).
  assert.equal(await scalar(`SELECT count(*) AS n FROM finance_journal_batch`), 3);
  // Revenue recognised 1500; COGS 120; payment 500 — reflected in the account movements.
  assert.equal(await scalar(`SELECT COALESCE(SUM(credit_minor),0) AS n FROM finance_journal_line WHERE account_code='4010-MEDICINE-REVENUE'`), 1500);
  assert.equal(await scalar(`SELECT COALESCE(SUM(debit_minor),0) AS n FROM finance_journal_line WHERE account_code='5000-COGS'`), 120);
  assert.equal(await scalar(`SELECT COALESCE(SUM(debit_minor),0) AS n FROM finance_journal_line WHERE account_code='1000-CASH'`), 500);
});

test('a replayed checkout is rejected and changes nothing (idempotency, NFR-010)', async () => {
  await commitCheckoutD1(db, req());
  await assert.rejects(commitCheckoutD1(db, req()), DuplicateCheckoutError);

  // Exactly one of everything — the replay wrote nothing.
  assert.equal(await scalar(`SELECT count(*) AS n FROM billing_invoice`), 1);
  assert.equal(await scalar(`SELECT count(*) AS n FROM billing_payment`), 1);
  assert.equal(await scalar(`SELECT count(*) AS n FROM finance_journal_batch`), 3);
  assert.equal(await scalar(`SELECT COALESCE(SUM(on_hand),0) AS n FROM inventory_stock_balance WHERE sku=?`, [SKU]), 90);
});

test('insufficient stock rolls the ENTIRE checkout back — nothing is written (BR-008)', async () => {
  await assert.rejects(commitCheckoutD1(db, req({ quantity: 500, enc: 'enc-x', inv: 'inv-x' })), StockError);

  // Atomic: no invoice, no payment, no journals, no idempotency key consumed, stock intact.
  assert.equal(await scalar(`SELECT count(*) AS n FROM billing_invoice`), 0);
  assert.equal(await scalar(`SELECT count(*) AS n FROM billing_payment`), 0);
  assert.equal(await scalar(`SELECT count(*) AS n FROM finance_journal_batch`), 0);
  assert.equal(await scalar(`SELECT count(*) AS n FROM security_sync_applied_change`), 0);
  assert.equal(await scalar(`SELECT COALESCE(SUM(on_hand),0) AS n FROM inventory_stock_balance WHERE sku=?`, [SKU]), 100);
});
