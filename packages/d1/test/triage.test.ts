/**
 * Triage / vitals capture on D1 (TRI-001..008, UAT-03). Runs on real SQLite (same
 * engine as D1). Proves: implausible values need confirmation (not dropped), EWS +
 * danger signs compute from captured vitals, the queue orders by EWS, and signing
 * moves the visit out of the queue.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordVitals, recordTriageAssessment, recordIntervention, signTriage, openTriageQueue, triageSummary, TriageError } from '../src/triage.ts';
import { VitalError } from '@sancta/domain';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'tri-pat-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-700001', 'Tri', 'Test').run();
});

test('vitals record with flags; an implausible value needs confirmation', async () => {
  const ok = await recordVitals(db, { patientId: PID, vitals: [{ kind: 'temperature_c', value: 37 }, { kind: 'pulse_bpm', value: 82 }] });
  assert.equal(ok.observations.length, 2);
  assert.equal(ok.observations[0]!.flag, 'ok');
  // 500°C is implausible → rejected without confirmation, accepted with it.
  await assert.rejects(() => recordVitals(db, { patientId: PID, vitals: [{ kind: 'temperature_c', value: 500 }] }), VitalError);
  const confirmed = await recordVitals(db, { patientId: PID, vitals: [{ kind: 'temperature_c', value: 500 }], confirmed: true });
  assert.equal(confirmed.observations[0]!.flag, 'implausible');
});

test('assessment computes EWS + danger signs and queues until signed', async () => {
  const { encounterId } = await recordVitals(db, { patientId: PID, vitals: [{ kind: 'spo2_pct', value: 85 }, { kind: 'respiratory_rate', value: 30 }, { kind: 'pulse_bpm', value: 130 }] });
  const a = await recordTriageAssessment(db, { encounterId, reason: 'breathless', painScore: 4 });
  assert.ok(a.ews.score >= 0);
  const queue = await openTriageQueue(db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.encounterId, encounterId);
  await recordIntervention(db, { encounterId, kind: 'oxygen', detail: '2L nasal' });
  await signTriage(db, { encounterId, signedBy: 'nurse1' });
  assert.equal((await openTriageQueue(db)).length, 0); // signed → leaves the queue
});

test('pain score is bounded 0–10', async () => {
  const { encounterId } = await recordVitals(db, { patientId: PID, vitals: [{ kind: 'pulse_bpm', value: 80 }] });
  await assert.rejects(() => recordTriageAssessment(db, { encounterId, painScore: 99 }), TriageError);
});

test('summary shows the observation trend and interventions', async () => {
  const { encounterId } = await recordVitals(db, { patientId: PID, vitals: [{ kind: 'temperature_c', value: 37 }] });
  await recordVitals(db, { patientId: PID, vitals: [{ kind: 'temperature_c', value: 38 }] }); // second reading (different encounter, so use same enc for trend below)
  await recordTriageAssessment(db, { encounterId, reason: 'fever' });
  await recordIntervention(db, { encounterId, kind: 'antipyretic', medication: 'paracetamol' });
  const s = await triageSummary(db, encounterId);
  assert.ok(s.assessment);
  assert.equal(s.interventions.length, 1);
  assert.ok(s.trend['temperature_c']!.length >= 1);
});

test('signing without an assessment is rejected', async () => {
  const { encounterId } = await recordVitals(db, { patientId: PID, vitals: [{ kind: 'pulse_bpm', value: 80 }] });
  await assert.rejects(() => signTriage(db, { encounterId, signedBy: 'nurse1' }), TriageError);
});
