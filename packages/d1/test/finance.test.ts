/**
 * Financial period control on D1 (FIN-009, BR-010, UAT-13). Runs on real SQLite
 * (same engine as D1). Proves: closing needs an approver, a hard-closed period
 * rejects posting at the choke point, and reopening (with authority) restores
 * posting.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closePeriod, reopenPeriod, periodStatus, assertPeriodOpen, PeriodClosedError, FinanceError } from '../src/finance.ts';
import { recordPayment, BillingError } from '../src/billing.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'fin-pat-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-300001', 'Fin', 'Test').run();
});

test('closing a period requires an approver', async () => {
  await assert.rejects(() => closePeriod(db, { periodId: '2026-07' }), FinanceError);
  const c = await closePeriod(db, { periodId: '2026-07', approver: 'cfo' });
  assert.equal(c.status, 'hard_close');
  assert.equal(await periodStatus(db, '2026-07'), 'hard_close');
});

test('assertPeriodOpen throws for a hard-closed period only', async () => {
  await assertPeriodOpen(db, '2026-07'); // no row yet → allowed
  await closePeriod(db, { periodId: '2026-07', approver: 'cfo' });
  await assert.rejects(() => assertPeriodOpen(db, '2026-07'), PeriodClosedError);
});

test('a hard-closed period rejects posting; reopening restores it', async () => {
  await closePeriod(db, { periodId: '2026-07', approver: 'cfo' });
  // Posting into the closed period is rejected at the choke point.
  await assert.rejects(() => recordPayment(db, { patientId: PID, method: 'cash', amountMinor: 1000, postingDate: '2026-07-19' }), PeriodClosedError);
  // Reopen (with authority) and posting works again.
  await reopenPeriod(db, { periodId: '2026-07', approver: 'cfo', reason: 'late entry' });
  assert.equal(await periodStatus(db, '2026-07'), 'open');
  const p = await recordPayment(db, { patientId: PID, method: 'cash', amountMinor: 1000, postingDate: '2026-07-19' });
  assert.ok(p.paymentId);
});

test('reopening requires an approver', async () => {
  await assert.rejects(() => reopenPeriod(db, { periodId: '2026-07' }), FinanceError);
});
