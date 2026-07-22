/**
 * Chart-of-accounts / cost-centre / dimension admin on D1 (FIN-001). Runs on real
 * SQLite (same engine as D1). Proves: accounts are versioned effective-dated (a
 * revision closes the prior version, resolve-as-of picks the right one), duplicate
 * codes are rejected, the cost-centre guard rejects unknown/inactive centres, and
 * dimensions carry their values.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCostCentre, listCostCentres, assertCostCentreActive, defineAccount, reviseAccount, accountAsOf, chartOfAccounts, createDimension, addDimensionValue, listDimensions, ChartAdminError } from '../src/chart.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('cost centres register and the active-guard rejects unknown/inactive', async () => {
  await createCostCentre(db, { code: 'CC-OPD', name: 'Outpatient' });
  assert.equal((await listCostCentres(db)).length, 1);
  await assertCostCentreActive(db, 'CC-OPD'); // ok
  await assert.rejects(() => assertCostCentreActive(db, 'CC-NOPE'), ChartAdminError);
  await assert.rejects(() => createCostCentre(db, { code: 'CC-OPD', name: 'dup' }), ChartAdminError);
});

test('accounts are versioned effective-dated; resolve-as-of picks the right one', async () => {
  await defineAccount(db, { code: '6000-RENT', name: 'Rent', type: 'expense', effectiveFrom: '2026-01-01' });
  await assert.rejects(() => defineAccount(db, { code: '6000-RENT', name: 'dup', type: 'expense', effectiveFrom: '2026-01-01' }), ChartAdminError);
  await reviseAccount(db, { code: '6000-RENT', name: 'Rent & Rates', effectiveFrom: '2026-06-01' });
  const early = await accountAsOf(db, '6000-RENT', '2026-03-01');
  const late = await accountAsOf(db, '6000-RENT', '2026-07-01');
  assert.equal(early.name, 'Rent');            // v1 in force in March
  assert.equal(late.name, 'Rent & Rates');     // v2 in force in July
  const chart = await chartOfAccounts(db, '2026-07-01');
  assert.ok(chart.some((a) => a.code === '6000-RENT' && a.name === 'Rent & Rates'));
});

test('a revision must post-date the current version', async () => {
  await defineAccount(db, { code: '6100-UTIL', name: 'Utilities', type: 'expense', effectiveFrom: '2026-03-01' });
  await assert.rejects(() => reviseAccount(db, { code: '6100-UTIL', name: 'x', effectiveFrom: '2026-01-01' }), ChartAdminError);
});

test('dimensions carry their values', async () => {
  await createDimension(db, { code: 'PROGRAMME', name: 'Programme' });
  await addDimensionValue(db, { dimensionCode: 'PROGRAMME', valueCode: 'HIV', label: 'HIV care' });
  await assert.rejects(() => addDimensionValue(db, { dimensionCode: 'NOPE', valueCode: 'X', label: 'y' }), ChartAdminError);
  const dims = await listDimensions(db);
  assert.equal(dims.length, 1);
  assert.equal(dims[0]!.values[0]!.valueCode, 'HIV');
});
