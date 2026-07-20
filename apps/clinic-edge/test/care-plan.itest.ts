/**
 * Care plans + clinical document generation (EHR-006, EHR-011) against real
 * PostgreSQL. Proves: a plan carries goals + dated follow-ups; overdue follow-ups
 * surface on a queue and clear when done; and clinical documents assemble from
 * real captured data (visit summary from diagnoses, prescription, sick note,
 * referral).
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
import { createCarePlan, addGoal, addFollowUp, completeFollowUp, listCarePlans, overdueFollowUps, CarePlanError } from '../src/care-plan.ts';
import { generateVisitSummary, generatePrescription, generateSickNote, generateReferral } from '../src/docgen.ts';
import { openDraftEncounter, recordDiagnosis } from '../src/ehr.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const DOCTOR = '00000000-0000-7000-8000-0000000000e1';

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

test('a care plan carries goals + follow-ups; overdue ones queue and clear (EHR-006)', { skip }, async () => {
  const plan = await createCarePlan(pool, { patientId: PATIENT, title: 'Hypertension management', user: DOCTOR });
  await addGoal(pool, { carePlanId: plan.id, description: 'BP < 140/90', targetDate: '2026-10-01' });
  const overdueF = await addFollowUp(pool, { carePlanId: plan.id, description: 'BP recheck', dueDate: '2026-07-01' }); // past
  await addFollowUp(pool, { carePlanId: plan.id, description: 'Medication review', dueDate: '2026-12-01' }); // future
  await assert.rejects(createCarePlan(pool, { patientId: PATIENT, title: '' }), CarePlanError);
  await assert.rejects(addGoal(pool, { carePlanId: '00000000-0000-7000-8000-0000000009ff', description: 'x' }), CarePlanError);

  const view = await listCarePlans(pool, PATIENT);
  assert.equal(view[0]!.title, 'Hypertension management');
  assert.equal(view[0]!.goals.length, 1);
  assert.equal(view[0]!.followUps.length, 2);

  let overdue = await overdueFollowUps(pool, '2026-07-20');
  assert.ok(overdue.some((o) => o.id === overdueF.id), 'past-due follow-up should be overdue');
  assert.ok(!overdue.some((o) => o.description === 'Medication review'), 'future follow-up not overdue');

  await completeFollowUp(pool, { id: overdueF.id, user: DOCTOR });
  overdue = await overdueFollowUps(pool, '2026-07-20');
  assert.ok(!overdue.some((o) => o.id === overdueF.id), 'completed follow-up leaves the queue');
  await assert.rejects(completeFollowUp(pool, { id: overdueF.id }), /already closed/);
});

test('a visit summary assembles from real diagnoses (EHR-011)', { skip }, async () => {
  const enc = await openDraftEncounter(pool, { patientId: PATIENT });
  await recordDiagnosis(pool, { encounterId: enc.encounterId, code: 'J18', certainty: 'confirmed', rank: 1, user: DOCTOR });
  await pool.query(`UPDATE clinical.encounter SET content=$2 WHERE id=$1`, [enc.encounterId, JSON.stringify({ plan: 'Antibiotics 5 days' })]);

  const doc = await generateVisitSummary(pool, { encounterId: enc.encounterId, clinician: 'Dr B', date: '2026-07-20' });
  assert.equal(doc.type, 'visit_summary');
  assert.ok(doc.sections.some((s) => s.heading === 'Diagnoses' && s.lines.some((l) => l.includes('Pneumonia'))));
  assert.ok(doc.sections.some((s) => s.heading === 'Plan' && s.lines[0]!.includes('Antibiotics')));
  assert.ok(doc.sections.some((s) => s.lines.some((l) => l.includes('20/07/2026'))));
});

test('prescription, sick note and referral generate from patient data (EHR-011)', { skip }, async () => {
  const rx = await generatePrescription(pool, { patientId: PATIENT, prescriber: 'Dr B', items: [{ drug: 'Amoxicillin', dose: '500mg', frequency: 'TDS', duration: '5 days' }], date: '2026-07-20' });
  assert.ok(rx.sections.some((s) => s.lines.some((l) => l.includes('Amoxicillin'))));

  const note = await generateSickNote(pool, { patientId: PATIENT, from: '2026-07-20', to: '2026-07-24', reason: 'acute illness', clinician: 'Dr B' });
  assert.ok(note.sections.some((s) => s.lines.some((l) => l.includes('20/07/2026') && l.includes('24/07/2026'))));

  const ref = await generateReferral(pool, { patientId: PATIENT, referrer: 'Dr B', referTo: 'District Hospital', reason: 'CT imaging', findings: 'persistent symptoms', date: '2026-07-20' });
  assert.equal(ref.sections[0]!.heading, 'To');
  assert.ok(ref.sections.some((s) => s.heading === 'Relevant findings'));
});
