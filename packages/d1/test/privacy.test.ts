/**
 * Privacy views & authorised disclosure on D1 (VIS-009, MGT-009, PAT-010). Runs
 * on real SQLite. Proves: the public queue carries no PHI; the analytical extract
 * is pseudonymised with age bands (never DOB); and a patient-summary disclosure
 * needs a purpose and is recorded in the append-only disclosure log.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { publicQueue, analyticalExtract, exportPatientSummary, listPatientDisclosures, DisclosureError } from '../src/privacy.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'pv-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name, date_of_birth, sex) VALUES (?,?,?,?,?,?)`).bind(PID, 'MRN-PV1', 'Katherine', 'Johnson', '1918-08-26', 'f').run();
  await db.prepare(`INSERT INTO flow_visit (id, patient_id, status) VALUES ('pv-v1',?, 'open')`).bind(PID).run();
  await db.prepare(`INSERT INTO flow_queue_entry (id, visit_id, token, station, priority, status, created_at) VALUES ('pv-q1','pv-v1',7,'triage',100,'waiting','2026-07-20T08:00:00Z')`).run();
});

test('the public queue carries tokens/stations but no PHI', async () => {
  const q = await publicQueue(db, '2026-07-20T08:30:00Z');
  assert.equal(q.length, 1);
  assert.equal(q[0]?.token, 'T007');
  assert.equal(q[0]?.waitMinutes, 30);
  assert.equal(/Katherine|Johnson|MRN|pv-p1/.test(JSON.stringify(q)), false); // no identity
});

test('the analytical extract is pseudonymised with an age band, not DOB', async () => {
  const ext = await analyticalExtract(db, { asOf: '2026-07-20', exportedBy: 'analyst1' });
  assert.equal(ext.rowCount, 1);
  const rec = ext.records[0]!;
  assert.ok(rec.pseudoId.startsWith('p-'));
  assert.equal(/1918|08-26/.test(JSON.stringify(rec)), false); // no exact DOB
  assert.ok(rec.ageBand);
});

test('a patient-summary disclosure needs a purpose and is logged', async () => {
  await assert.rejects(() => exportPatientSummary(db, { patientId: PID, purpose: '' }), DisclosureError);
  const { summary, disclosureId, contentHash } = await exportPatientSummary(db, { patientId: PID, purpose: 'continuity of care', recipient: 'Dr Referral', disclosedBy: 'dr1' });
  assert.equal(summary.patient.name, 'Katherine Johnson');
  assert.ok(contentHash.length === 64); // sha-256 hex
  const log = await listPatientDisclosures(db, { patientId: PID });
  assert.equal(log.length, 1);
  assert.equal(log[0]?.id, disclosureId);
  assert.equal(log[0]?.purpose, 'continuity of care');
});
