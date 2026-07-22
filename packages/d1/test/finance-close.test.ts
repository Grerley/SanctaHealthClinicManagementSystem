/**
 * Month-end close + balance sheet on D1 (FIN-004/010). Runs on real SQLite (same
 * engine as D1). Proves: the balance sheet balances (assets = liabilities +
 * equity) by the double-entry identity, closing clears temporary accounts to
 * retained earnings and leaves the sheet balanced, and a period cannot be closed
 * twice.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { balanceSheet, monthlyClose } from '../src/finance-close.ts';
import { PeriodClosedError, FinanceError } from '../src/finance.ts';
import { commitCheckoutD1 } from '../src/checkout.ts';
import { receiveStock } from '../src/stock.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

async function seedSale(): Promise<void> {
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES ('cp1','SCC-050001','Close','Er')`).run();
  await receiveStock(db, { sku: 'AMOX-500', lotId: 'clot-1', expiryDate: '2027-01-01', unitCostMinor: 12, location: 'MAIN', quantity: 100 });
  await commitCheckoutD1(db, {
    dispense: { sku: 'AMOX-500', quantity: 10, patientId: 'cp1', encounterId: 'cenc-1', invoiceId: 'cinv-1', chargeMinor: 1500, asOfDate: '2026-07-19', postingDate: '2026-07-19', location: 'MAIN', device: 'd', user: 'u', site: 's' },
    paymentMinor: 1500, paymentMethod: 'cash', now: 1_700_000_000_000,
  });
}

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('the balance sheet balances by the double-entry identity', async () => {
  await seedSale();
  const bs = await balanceSheet(db);
  assert.equal(bs.balances, true);
  assert.equal(bs.assetsMinor, bs.liabilitiesMinor + bs.equityMinor);
  // Current earnings = revenue 1500 - COGS 120 = 1380, carried in equity pre-close.
  assert.equal(bs.retainedAndCurrentEarningsMinor, 1380);
});

test('close clears temporary accounts to retained earnings; sheet still balances', async () => {
  await seedSale();
  const mc = await monthlyClose(db, { periodId: '2026-07', approver: 'cfo' });
  assert.equal(mc.status, 'hard_close');
  assert.equal(mc.netResultMinor, 1380);
  assert.ok(mc.closingBatchId);
  const bs = await balanceSheet(db);
  assert.equal(bs.balances, true); // identity preserved after closing entry
  // A second close is refused.
  await assert.rejects(() => monthlyClose(db, { periodId: '2026-07', approver: 'cfo' }), PeriodClosedError);
});

test('closing requires an approver', async () => {
  await assert.rejects(() => monthlyClose(db, { periodId: '2026-07', approver: '' }), FinanceError);
});
