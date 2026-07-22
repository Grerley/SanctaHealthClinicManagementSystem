/**
 * Financial statements + fixed assets + margin on D1 (FIN-008/010/011/014). Runs
 * on real SQLite (same engine as D1). Proves: a full dispense-and-pay produces a
 * BALANCED trial balance, the income statement reconciles to it, the ledger export
 * balances and is idempotent, and asset depreciation/disposal computes correctly.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { trialBalance, incomeStatement, exportApprovedLedger, capitaliseAsset, assetRegister, disposeAsset, marginReport, FixedAssetError } from '../src/finance-reports.ts';
import { commitCheckoutD1 } from '../src/checkout.ts';
import { receiveStock } from '../src/stock.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

async function seedSale(): Promise<void> {
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES ('fp1','SCC-200001','Fin','Rep')`).run();
  await receiveStock(db, { sku: 'AMOX-500', lotId: 'flot-1', expiryDate: '2027-01-01', unitCostMinor: 12, location: 'MAIN', quantity: 100 });
  await commitCheckoutD1(db, {
    dispense: { sku: 'AMOX-500', quantity: 10, patientId: 'fp1', encounterId: 'fenc-1', invoiceId: 'finv-1', chargeMinor: 1500, asOfDate: '2026-07-19', postingDate: '2026-07-19', location: 'MAIN', device: 'd', user: 'u', site: 's' },
    paymentMinor: 1500, paymentMethod: 'cash', now: 1_700_000_000_000,
  });
}

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('a sale yields a balanced trial balance and a reconciling income statement', async () => {
  await seedSale();
  const tb = await trialBalance(db);
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebitMinor, tb.totalCreditMinor);
  const is = await incomeStatement(db);
  assert.equal(is.reconcilesToTrialBalance, true);
  assert.equal(is.revenueMinor, 1500);            // medicine revenue
  assert.equal(is.expensesMinor, 120);            // COGS 10 * 12
  assert.equal(is.netResultMinor, 1380);
});

test('ledger export balances and is deterministic (idempotent key)', async () => {
  await seedSale();
  const a = await exportApprovedLedger(db, { periodId: '2026-07', exportedBy: 'cfo' });
  assert.equal(a.balanced, true);
  assert.ok(a.lineCount > 0);
  const b = await exportApprovedLedger(db, { periodId: '2026-07', exportedBy: 'cfo' });
  assert.equal(a.idempotencyKey, b.idempotencyKey); // same content → same key
  await assert.rejects(() => exportApprovedLedger(db, { periodId: '1999-01' }), /unknown financial period/);
});

test('assets depreciate straight-line and dispose with gain/loss', async () => {
  await capitaliseAsset(db, { reference: 'FA-1', name: 'Autoclave', costMinor: 120000, salvageMinor: 0, usefulLifeMonths: 60, acquiredOn: '2026-01-01' });
  await assert.rejects(() => capitaliseAsset(db, { reference: 'FA-2', name: 'Bad', costMinor: 100, salvageMinor: 200, usefulLifeMonths: 12, acquiredOn: '2026-01-01' }), FixedAssetError);
  const reg = await assetRegister(db, { asOf: '2026-07-01' }); // 6 months elapsed
  assert.equal(reg.length, 1);
  assert.equal(reg[0]!.monthlyMinor, 2000);        // 120000 / 60
  assert.equal(reg[0]!.accumulatedMinor, 12000);   // 6 * 2000
  assert.equal(reg[0]!.netBookValueMinor, 108000);
  const d = await disposeAsset(db, { assetId: reg[0]!.id, disposedOn: '2026-07-01', proceedsMinor: 110000 });
  assert.equal(d.gainLossMinor, 2000);             // 110000 - 108000
  await assert.rejects(() => disposeAsset(db, { assetId: reg[0]!.id, disposedOn: '2026-07-01', proceedsMinor: 1 }), FixedAssetError);
});

test('margin ties revenue to actual stock consumption', async () => {
  await seedSale();
  const m = await marginReport(db);
  const amox = m.products.find((p) => p.sku === 'AMOX-500');
  assert.equal(amox?.revenueMinor, 1500);
  assert.equal(amox?.cogsMinor, 120);
  assert.equal(amox?.grossMarginMinor, 1380);
});
