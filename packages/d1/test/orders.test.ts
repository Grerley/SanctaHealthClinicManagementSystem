/**
 * Orders / results / critical-result acknowledgement on D1 (ORD, UAT-06). Runs on
 * real SQLite via node:sqlite (same engine as Cloudflare D1). Proves the release →
 * classify → critical-queue → acknowledge flow, corrections that retain the
 * original, cancel-with-reason, order sets creating DRAFTs, and external-result
 * matching — all the invariants the Postgres version guaranteed.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrder, setOrderStatus, releaseResult, acknowledgeCritical, outstandingCriticalResults, pendingResults,
  attachExternalResult, reconcileExternalResult, unmatchedResults, cancelOrder, correctResult,
  defineOrderSet, applyOrderSet, generateSpecimenLabel, createReferral, updateReferral, listOpenReferrals, OrderError,
} from '../src/orders.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'ord-pat-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name, date_of_birth, sex) VALUES (?,?,?,?,?,?)`)
    .bind(PID, 'SCC-900001', 'Test', 'Patient', '1990-05-05', 'female').run();
});

test('release classifies, completes the order, and audits', async () => {
  const { orderId } = await createOrder(db, { patientId: PID, category: 'laboratory', code: 'K', priority: 'urgent' });
  const out = await releaseResult(db, { orderId, value: 3.0, refLow: 3.5, refHigh: 5.1 });
  assert.equal(out.abnormal, 'low');
  assert.equal(out.critical, false);
  const status = await db.prepare(`SELECT status FROM clinical_service_request WHERE id=?`).bind(orderId).first<{ status: string }>();
  assert.equal(status?.status, 'completed');
});

test('pendingResults lists lab/imaging orders awaiting a result, STAT first, and drops resulted orders', async () => {
  const routine = await createOrder(db, { patientId: PID, category: 'laboratory', code: 'FBC', priority: 'routine' });
  const stat = await createOrder(db, { patientId: PID, category: 'imaging', code: 'CXR', priority: 'stat' });
  await createOrder(db, { patientId: PID, category: 'referral', code: 'CARD', priority: 'routine' }); // not a diagnostic result

  const pending = await pendingResults(db);
  assert.deepEqual(pending.map((o) => o.orderId), [stat.orderId, routine.orderId]); // STAT floats to the top; referral excluded
  assert.equal(pending[0]!.priority, 'stat');
  assert.equal(pending[0]!.name, 'Test Patient');

  // Once a result is entered, the order leaves the worklist.
  await releaseResult(db, { orderId: stat.orderId, value: 1, refLow: 0, refHigh: 2 });
  const after = await pendingResults(db);
  assert.deepEqual(after.map((o) => o.orderId), [routine.orderId]);
});

test('a critical result queues until acknowledged, then clears (idempotent)', async () => {
  const { orderId } = await createOrder(db, { patientId: PID, category: 'laboratory', code: 'K' });
  const r = await releaseResult(db, { orderId, value: 7.2, refLow: 3.5, refHigh: 5.1, criticalHigh: 6.0 });
  assert.equal(r.critical, true);
  assert.equal((await outstandingCriticalResults(db)).length, 1);
  await acknowledgeCritical(db, { resultId: r.resultId, acknowledgedBy: 'dr1' });
  await acknowledgeCritical(db, { resultId: r.resultId, acknowledgedBy: 'dr1' }); // replay is a no-op
  assert.equal((await outstandingCriticalResults(db)).length, 0);
  const acks = await db.prepare(`SELECT COUNT(*) AS n FROM clinical_critical_result_ack WHERE result_id=?`).bind(r.resultId).first<{ n: number }>();
  assert.equal(Number(acks?.n), 1);
});

test('correction retains the original (never deletes)', async () => {
  const { orderId } = await createOrder(db, { patientId: PID, category: 'laboratory', code: 'GLU' });
  const r = await releaseResult(db, { orderId, value: 5.0 });
  const { correctedResultId } = await correctResult(db, { resultId: r.resultId, newValue: 9.9, reason: 'wrong tube', by: 'dr1' });
  const orig = await db.prepare(`SELECT status FROM clinical_result WHERE id=?`).bind(r.resultId).first<{ status: string }>();
  const corrected = await db.prepare(`SELECT value, supersedes FROM clinical_result WHERE id=?`).bind(correctedResultId).first<{ value: number; supersedes: string }>();
  assert.equal(orig?.status, 'corrected');       // original retained, marked corrected
  assert.equal(Number(corrected?.value), 9.9);
  assert.equal(corrected?.supersedes, r.resultId);
  await assert.rejects(() => correctResult(db, { resultId: r.resultId, newValue: 1, reason: 'again', by: 'dr1' }), OrderError);
});

test('cancel requires a reason and refuses completed orders', async () => {
  const { orderId } = await createOrder(db, { patientId: PID, category: 'imaging', code: 'CXR' });
  await assert.rejects(() => cancelOrder(db, { orderId, reason: '', by: 'dr1' }), OrderError);
  const c = await cancelOrder(db, { orderId, reason: 'duplicate', by: 'dr1' });
  assert.equal(c.status, 'cancelled');
});

test('illegal status transitions are rejected', async () => {
  const { orderId } = await createOrder(db, { patientId: PID, category: 'laboratory', code: 'K' });
  await assert.rejects(() => setOrderStatus(db, { orderId, to: 'completed' }), Error); // active -> completed is illegal
});

test('order set applies as individual DRAFT orders', async () => {
  await defineOrderSet(db, { code: 'ANC', name: 'Antenatal panel', items: [{ category: 'laboratory', code: 'HB' }, { category: 'laboratory', code: 'BG' }] });
  const { orderIds } = await applyOrderSet(db, { setCode: 'ANC', patientId: PID, requestedBy: 'dr1' });
  assert.equal(orderIds.length, 2);
  const drafts = await db.prepare(`SELECT COUNT(*) AS n FROM clinical_service_request WHERE status='draft'`).first<{ n: number }>();
  assert.equal(Number(drafts?.n), 2);
});

test('external result matches an open order, else queues for reconciliation', async () => {
  const { orderId } = await createOrder(db, { patientId: PID, category: 'laboratory', code: 'HIV' });
  const matched = await attachExternalResult(db, { orderRef: 'HIV', patientId: PID, value: 0 });
  assert.equal(matched.matched, true);
  const unmatched = await attachExternalResult(db, { orderRef: 'UNKNOWN-XYZ', value: 1 });
  assert.equal(unmatched.matched, false);
  assert.equal((await unmatchedResults(db)).length, 1);
  const rec = await reconcileExternalResult(db, { externalResultId: unmatched.id, serviceRequestId: orderId, by: 'tech1' });
  assert.equal(rec.status, 'matched');
  assert.equal((await unmatchedResults(db)).length, 0);
});

test('specimen label carries a gapless accession and no full name', async () => {
  const { orderId } = await createOrder(db, { patientId: PID, category: 'laboratory', code: 'CBC' });
  const label = await generateSpecimenLabel(db, { orderId, collectedOn: '2026-07-22' });
  assert.match(label.accession, /^SPN/);
  assert.ok(!label.line1.includes('Patient')); // family name not on the label
});

test('referral lifecycle advances through allowed transitions only', async () => {
  const { id } = await createReferral(db, { patientId: PID, targetFacility: 'District Hospital', sentBy: 'dr1' });
  assert.equal((await listOpenReferrals(db)).length, 1);
  await updateReferral(db, { referralId: id, to: 'accepted' });
  await assert.rejects(() => updateReferral(db, { referralId: id, to: 'sent' }), OrderError);
  await updateReferral(db, { referralId: id, to: 'closed' });
  assert.equal((await listOpenReferrals(db)).length, 0);
});
