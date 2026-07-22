/**
 * Budgets & variance on D1 (FIN-007). Runs on real SQLite (same engine as D1).
 * Proves: a budget is set/replaced per account+period, an unknown account is
 * rejected, and variance derives ACTUAL from the ledger so it reconciles (a
 * dispense-and-pay produces the expected revenue actual against budget).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setBudget, budgetVariance, BudgetError } from '../src/finance-budget.ts';
import { commitCheckoutD1 } from '../src/checkout.ts';
import { receiveStock } from '../src/stock.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('setBudget upserts per account+period and rejects unknown accounts', async () => {
  const a = await setBudget(db, { accountCode: '4010-MEDICINE-REVENUE', periodId: '2026-07', amountMinor: 100000 });
  const b = await setBudget(db, { accountCode: '4010-MEDICINE-REVENUE', periodId: '2026-07', amountMinor: 120000 });
  assert.equal(a.id, b.id); // same (account, period, null site) → replaced, not duplicated
  await assert.rejects(() => setBudget(db, { accountCode: '9999-NOPE', periodId: '2026-07', amountMinor: 1 }), BudgetError);
  await assert.rejects(() => setBudget(db, { accountCode: '4010-MEDICINE-REVENUE', periodId: '2026-07', amountMinor: 1.5 }), BudgetError);
});

test('variance derives actual from the ledger', async () => {
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES ('bp1','SCC-100001','Bud','Get')`).run();
  await receiveStock(db, { sku: 'AMOX-500', lotId: 'blot-1', expiryDate: '2027-01-01', unitCostMinor: 12, location: 'MAIN', quantity: 100 });
  await commitCheckoutD1(db, {
    dispense: { sku: 'AMOX-500', quantity: 10, patientId: 'bp1', encounterId: 'benc-1', invoiceId: 'binv-1', chargeMinor: 1500, asOfDate: '2026-07-19', postingDate: '2026-07-19', location: 'MAIN', device: 'd', user: 'u', site: 's' },
    paymentMinor: 1500, paymentMethod: 'cash', now: 1_700_000_000_000,
  });
  await setBudget(db, { accountCode: '4010-MEDICINE-REVENUE', periodId: '2026-07', amountMinor: 2000 });
  const v = await budgetVariance(db, { periodId: '2026-07' });
  const rev = v.rows.find((r) => r.accountCode === '4010-MEDICINE-REVENUE');
  // Revenue is credit-normal → debit-positive net is -1500 actual vs 2000 budget.
  assert.equal(rev?.budgetMinor, 2000);
  assert.equal(rev?.actualMinor, -1500);
  assert.equal(rev?.varianceMinor, -3500);
});
