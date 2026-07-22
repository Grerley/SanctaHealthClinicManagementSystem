/**
 * Cashier shift open/close on D1 (BIL-009, UAT-09). Runs on real SQLite (same
 * engine as D1). Proves: a balanced close, a variance posting a cash-over/short
 * journal, the supervisor-approval gate above tolerance (throws without approver),
 * and no double-close.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openShift, closeCashierShift, ShiftError, CashierError } from '../src/cashier.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'csh-p1';

async function cashPayment(shiftId: string, amountMinor: number): Promise<void> {
  await db.prepare(`INSERT INTO billing_payment (id, receipt_number, patient_id, method, amount_minor, currency, status, shift_id) VALUES (?,?,?,?,?, 'USD','confirmed',?)`)
    .bind('pay-' + amountMinor + '-' + shiftId.slice(-4), 'RCT-' + amountMinor, PID, 'cash', amountMinor, shiftId).run();
}
function denom(unitMinor: number, count: number) { return { unitMinor, count }; }

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-030001', 'Cash', 'Ier').run();
});

test('a balanced shift closes with zero variance and no journal', async () => {
  const { shiftId } = await openShift(db, { cashier: 'c1', openingFloatMinor: 10000 });
  await cashPayment(shiftId, 5000); // expected = 10000 + 5000 = 15000
  const r = await closeCashierShift(db, { shiftId, toleranceMinor: 100, denominations: [denom(5000, 3)], postingDate: '2026-07-19' }); // 3*5000 = 15000
  assert.equal(r.varianceMinor, 0);
  assert.equal(r.status, 'closed');
  const jl = await db.prepare(`SELECT COUNT(*) AS n FROM finance_journal_line WHERE account_code='6900-CASH-OVER-SHORT'`).first<{ n: number }>();
  assert.equal(Number(jl?.n), 0); // no variance → no cash-over/short posting
});

test('a within-tolerance variance closes and posts a cash-over/short journal', async () => {
  const { shiftId } = await openShift(db, { cashier: 'c1', openingFloatMinor: 10000 });
  await cashPayment(shiftId, 5000); // expected 15000
  const r = await closeCashierShift(db, { shiftId, toleranceMinor: 100, denominations: [denom(5000, 2), denom(1000, 4), denom(50, 18)], postingDate: '2026-07-19' }); // 10000+4000+900 = 14900
  assert.equal(r.varianceMinor, -100); // short by 100
  const jl = await db.prepare(`SELECT COALESCE(SUM(debit_minor),0) AS d FROM finance_journal_line WHERE account_code='6900-CASH-OVER-SHORT'`).first<{ d: number }>();
  assert.equal(Number(jl?.d), 100); // Dr cash over/short for the shortage
});

test('a variance above tolerance needs a supervisor approver', async () => {
  const { shiftId } = await openShift(db, { cashier: 'c1', openingFloatMinor: 10000 });
  await cashPayment(shiftId, 5000); // expected 15000
  // Counted 14000 → variance -1000 > tolerance 100 → throws without approver.
  await assert.rejects(() => closeCashierShift(db, { shiftId, toleranceMinor: 100, denominations: [denom(1000, 14)], postingDate: '2026-07-19' }), CashierError);
  const approved = await closeCashierShift(db, { shiftId, toleranceMinor: 100, denominations: [denom(1000, 14)], approver: 'super', postingDate: '2026-07-19' });
  assert.equal(approved.requiresApproval, true);
  assert.equal(approved.approved, true);
});

test('a shift cannot be closed twice', async () => {
  const { shiftId } = await openShift(db, { cashier: 'c1', openingFloatMinor: 0 });
  await closeCashierShift(db, { shiftId, toleranceMinor: 100, denominations: [], postingDate: '2026-07-19' });
  await assert.rejects(() => closeCashierShift(db, { shiftId, toleranceMinor: 100, denominations: [], postingDate: '2026-07-19' }), ShiftError);
});
