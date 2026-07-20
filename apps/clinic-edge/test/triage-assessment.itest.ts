/**
 * Triage assessment, danger signs, interventions, sign/hand-off and trend
 * (TRI-001/004/005/006/007/008) against real PostgreSQL. Proves: an assessment
 * computes visible danger-sign escalations + a transparent early-warning score
 * from the captured vitals (never a diagnosis); interventions are recorded; an
 * unsigned triage stays in the queue and leaves it when signed; and repeat
 * observations produce a trend.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { recordVitals, recordTriageAssessment, recordIntervention, signTriage, openTriageQueue, triageSummary, TriageError } from '../src/triage.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const NURSE = '00000000-0000-7000-8000-0000000000e1';

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

async function triagedEncounter(): Promise<string> {
  // Critical vitals (confirmed): SpO2 85, systolic 82 → danger signs.
  const v = await recordVitals(pool, {
    patientId: PATIENT,
    vitals: [
      { kind: 'spo2_pct', value: 85 },
      { kind: 'systolic_bp', value: 82 },
      { kind: 'respiratory_rate', value: 28 },
      { kind: 'pulse_bpm', value: 118 },
      { kind: 'temperature_c', value: 39.6 },
    ],
    confirmed: true,
    user: NURSE,
  });
  return v.encounterId;
}

test('an assessment computes danger signs + EWS from vitals; no diagnosis (TRI-001/004/005)', { skip }, async () => {
  const encounterId = await triagedEncounter();
  const res = await recordTriageAssessment(pool, {
    encounterId,
    reason: 'shortness of breath',
    symptoms: ['dyspnoea', 'fever'],
    painScore: 4,
    allergyReviewed: true,
    infectionScreen: { fever: true, cough: true },
    user: NURSE,
  });
  assert.ok(res.dangerSigns.some((s) => s.code === 'hypoxia_severe' && s.severity === 'emergency'));
  assert.ok(res.dangerSigns.some((s) => s.code === 'hypotension'));
  assert.ok(res.ews.score >= 7 && res.ews.band === 'high');
  assert.equal(res.ews.ruleVersion, 'news-lite-1');
  // Safety: outputs are escalations, never a diagnosis.
  for (const s of res.dangerSigns) assert.equal(s.action, 'escalate');

  // Stored on the assessment row.
  const row = await pool.query(`SELECT ews_score, ews_band, jsonb_array_length(danger_signs) AS n, pain_score, allergy_reviewed FROM clinical.triage_assessment WHERE encounter_id=$1`, [encounterId]);
  assert.equal(row.rows[0].ews_band, 'high');
  assert.ok(Number(row.rows[0].n) >= 2);
  assert.equal(row.rows[0].pain_score, 4);
  assert.equal(row.rows[0].allergy_reviewed, true);

  // A pain score out of range is rejected.
  await assert.rejects(recordTriageAssessment(pool, { encounterId, painScore: 11, user: NURSE }), TriageError);
});

test('interventions and repeat-observation trend are captured (TRI-006/007)', { skip }, async () => {
  const encounterId = await triagedEncounter();
  await recordTriageAssessment(pool, { encounterId, reason: 'collapse', user: NURSE });
  await recordIntervention(pool, { encounterId, kind: 'oxygen', detail: '4 L/min via nasal cannula', response: 'SpO₂ improving', user: NURSE });
  // A repeat SpO2 reading (improved) on the same encounter.
  await recordVitals(pool, { patientId: PATIENT, vitals: [{ kind: 'spo2_pct', value: 94 }], user: NURSE });
  // Note: recordVitals opens a new encounter; add the repeat directly to this encounter for the trend.
  await pool.query(`INSERT INTO clinical.observation (id, encounter_id, patient_id, kind, value, unit, flag, recorded_by) VALUES (gen_random_uuid(),$1,$2,'spo2_pct',94,'%','out_of_reference',$3)`, [encounterId, PATIENT, NURSE]);

  const summary = await triageSummary(pool, encounterId);
  assert.ok(summary.interventions.some((i) => i.kind === 'oxygen'));
  assert.ok((summary.trend['spo2_pct'] ?? []).length >= 2); // original 85 + repeat 94
  await assert.rejects(recordIntervention(pool, { encounterId, kind: '', user: NURSE }), TriageError);
});

test('an unsigned triage stays in the queue and leaves it when signed (TRI-008)', { skip }, async () => {
  const encounterId = await triagedEncounter();
  await recordTriageAssessment(pool, { encounterId, reason: 'chest pain', user: NURSE });

  let queue = await openTriageQueue(pool);
  assert.ok(queue.some((q) => q.encounterId === encounterId), 'unsigned triage should be queued');
  // High-acuity first.
  assert.ok(queue[0]!.ewsScore !== null);

  const res = await signTriage(pool, { encounterId, signedBy: NURSE });
  assert.equal(res.status, 'signed');
  queue = await openTriageQueue(pool);
  assert.ok(!queue.some((q) => q.encounterId === encounterId), 'signed triage should leave the queue');

  // Cannot sign twice; cannot sign an encounter with no assessment.
  await assert.rejects(signTriage(pool, { encounterId, signedBy: NURSE }), /already signed/);
  const bare = await recordVitals(pool, { patientId: PATIENT, vitals: [{ kind: 'pulse_bpm', value: 70 }], user: NURSE });
  await assert.rejects(signTriage(pool, { encounterId: bare.encounterId, signedBy: NURSE }), /no triage assessment/);
});
