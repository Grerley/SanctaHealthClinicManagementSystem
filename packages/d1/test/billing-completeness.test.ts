/**
 * Encounter-to-charge completeness on D1 (BIL-002/012, BR-004). Runs on real
 * SQLite. Proves: only a billable encounter can be charged or excepted; a charge
 * exception requires reason + approver; and the day-close report counts a signed
 * billable-but-pending encounter as a revenue-leakage gap while resolved ones
 * lift completeness to 100%.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { markBillable, linkCharge, authoriseException, chargeCaptureReport, ChargeError } from '../src/billing-completeness.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'bc-p1';

async function signedEncounter(id: string): Promise<void> {
  await db.prepare(`INSERT INTO clinical_encounter (id, visit_id, patient_id, status, signed_by, signed_at) VALUES (?,?,?,'signed','dr1','2026-07-01T09:00:00Z')`)
    .bind(id, 'v-' + id, PID).run();
}

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn) VALUES (?,?)`).bind(PID, 'MRN-BC1').run();
});

test('only a billable encounter can be charged; non-billable is rejected', async () => {
  await signedEncounter('e1');
  await assert.rejects(() => linkCharge(db, { encounterId: 'e1', invoiceId: 'inv-1' }), ChargeError); // not billable yet
  await markBillable(db, 'e1');
  await linkCharge(db, { encounterId: 'e1', invoiceId: 'inv-1' });
  const rep = await chargeCaptureReport(db);
  assert.equal(rep.billableCompleted, 1);
  assert.equal(rep.charged, 1);
  assert.equal(rep.completenessPct, 100);
});

test('a charge exception requires reason and approver', async () => {
  await signedEncounter('e2');
  await markBillable(db, 'e2');
  await assert.rejects(() => authoriseException(db, { encounterId: 'e2', outcome: 'waived', reason: '', approver: 'mgr1' }), ChargeError);
  await assert.rejects(() => authoriseException(db, { encounterId: 'e2', outcome: 'waived', reason: 'goodwill', approver: '' }), ChargeError);
  await authoriseException(db, { encounterId: 'e2', outcome: 'waived', reason: 'goodwill', approver: 'mgr1' });
  const rep = await chargeCaptureReport(db);
  assert.equal(rep.authorisedExceptions, 1);
  assert.equal(rep.completenessPct, 100);
});

test('a signed billable-but-pending encounter is a revenue-leakage gap', async () => {
  await signedEncounter('e3'); await markBillable(db, 'e3'); // pending
  await signedEncounter('e4'); await markBillable(db, 'e4'); await linkCharge(db, { encounterId: 'e4', invoiceId: 'inv-4' });
  const rep = await chargeCaptureReport(db);
  assert.equal(rep.billableCompleted, 2);
  assert.equal(rep.gaps.length, 1);
  assert.equal(rep.gaps[0]?.encounterId, 'e3');
  assert.equal(rep.completenessPct, 50);
});
