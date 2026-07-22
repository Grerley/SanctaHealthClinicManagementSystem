/**
 * Patient clinical timeline on D1 (EHR-002). Runs on real SQLite. Proves: events
 * from encounters, observations and results merge into one time-ordered view with
 * provenance; filtering by type and date window works; critical/abnormal results
 * carry flags.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { patientTimeline } from '../src/timeline.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'tl-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn) VALUES (?,?)`).bind(PID, 'MRN-TL1').run();
  await db.prepare(`INSERT INTO clinical_encounter (id, visit_id, patient_id, status, form_code, signed_by, signed_at, created_at) VALUES (?,?,?,'signed','SOAP','dr1','2026-07-10T09:00:00Z','2026-07-10T08:00:00Z')`).bind('enc1', 'v1', PID).run();
  await db.prepare(`INSERT INTO clinical_observation (id, encounter_id, patient_id, kind, value, unit, flag, recorded_by, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind('obs1', 'enc1', PID, 'temperature', 38.5, 'C', 'high', 'nurse1', '2026-07-10T08:30:00Z').run();
  await db.prepare(`INSERT INTO clinical_service_request (id, patient_id, category, code, requested_by) VALUES (?,?,?,?,?)`).bind('sr1', PID, 'lab', 'GLUCOSE', 'dr1').run();
  await db.prepare(`INSERT INTO clinical_result (id, service_request_id, patient_id, value, unit, abnormal, critical, verified_by, released_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind('res1', 'sr1', PID, 15.2, 'mmol/L', 'high', 1, 'dr1', '2026-07-11T10:00:00Z').run();
});

test('events merge into one time-ordered view with provenance', async () => {
  const items = await patientTimeline(db, PID);
  assert.equal(items.length, 3);
  // Sorted ascending by time: observation (08:30) < encounter (09:00 signed) < result (11th).
  assert.deepEqual(items.map((i) => i.type), ['observation', 'encounter', 'result']);
  assert.equal(items[1]?.author, 'dr1'); // encounter provenance = signer
});

test('critical results carry flags; type filter narrows the view', async () => {
  const results = await patientTimeline(db, PID, { type: 'result' });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.flags?.sort(), ['critical', 'high']);
  const encounters = await patientTimeline(db, PID, { type: 'encounter' });
  assert.equal(encounters.length, 1);
});

test('date window filters the timeline', async () => {
  const onlyDay11 = await patientTimeline(db, PID, { from: '2026-07-11T00:00:00Z' });
  assert.equal(onlyDay11.length, 1);
  assert.equal(onlyDay11[0]?.type, 'result');
});
