/**
 * Versioned structured clinical forms (EHR-003) + patient timeline (EHR-002)
 * against real PostgreSQL. Proves: an encounter bound to a form can only be signed
 * with content valid for that exact form version; a form is versioned/effective-
 * dated so a later revision never changes an earlier encounter; and the patient
 * timeline assembles encounters, addenda, observations and results chronologically
 * with provenance and filtering.
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
import { FormError } from '@sancta/domain';
import { createDraftEncounter, signEncounter, attachForm, addAddendum } from '../src/encounters.ts';
import { defineForm, listForms, formAsOf, FormAdminError } from '../src/forms.ts';
import { patientTimeline } from '../src/timeline.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const DOCTOR = '00000000-0000-7000-8000-0000000000e1';
const ADMIN = '00000000-0000-7000-8000-0000000000c1';

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

test('the seeded HEAP form v1 is resolvable (EHR-003)', { skip }, async () => {
  const def = await formAsOf(pool, 'HEAP', '2026-07-20');
  assert.equal(def.version, 1);
  assert.ok(def.fields.some((f) => f.key === 'assessment' && f.required));
  assert.ok((await listForms(pool, '2026-07-20')).some((f) => f.formCode === 'HEAP'));
});

test('a form-bound encounter must be signed with valid content (EHR-003)', { skip }, async () => {
  const { encounterId } = await createDraftEncounter(pool, { patientId: PATIENT });
  await attachForm(pool, { encounterId, formCode: 'HEAP', onDate: '2026-07-20' });

  // Missing the required assessment/plan → sign is rejected.
  await assert.rejects(signEncounter(pool, { encounterId, signedBy: DOCTOR, content: { history: 'cough' } }), FormError);
  // An invalid code is rejected.
  await assert.rejects(signEncounter(pool, { encounterId, signedBy: DOCTOR, content: { history: 'x', assessment: 'y', plan: 'z', severity: 'fatal' } }), FormError);
  // Valid content signs.
  const res = await signEncounter(pool, { encounterId, signedBy: DOCTOR, content: { history: 'cough 3d', assessment: 'URTI', plan: 'fluids', severity: 'mild' } });
  assert.equal(res.status, 'signed');
});

test('forms are versioned; a revision does not change an earlier encounter (EHR-003)', { skip }, async () => {
  // Revise HEAP from 1 Aug adding a mandatory field.
  await assert.rejects(defineForm(pool, { formCode: 'HEAP', title: 'x', fields: [], effectiveFrom: '2026-09-01', by: ADMIN }), FormAdminError); // no fields
  const rev = await defineForm(pool, {
    formCode: 'HEAP', title: 'HEAP v2', effectiveFrom: '2026-08-01', by: ADMIN,
    fields: [
      { key: 'history', label: 'History', type: 'text', required: true },
      { key: 'assessment', label: 'Assessment', type: 'text', required: true },
      { key: 'plan', label: 'Plan', type: 'text', required: true },
      { key: 'followup', label: 'Follow-up date', type: 'date', required: true },
    ],
  });
  assert.equal(rev.version, 2);
  // July still resolves v1 (no follow-up required); August resolves v2.
  assert.equal((await formAsOf(pool, 'HEAP', '2026-07-20')).version, 1);
  assert.equal((await formAsOf(pool, 'HEAP', '2026-08-15')).version, 2);

  // A v1-bound encounter still signs without the v2 mandatory field.
  const { encounterId } = await createDraftEncounter(pool, { patientId: PATIENT });
  await attachForm(pool, { encounterId, formCode: 'HEAP', onDate: '2026-07-20' }); // binds v1
  const res = await signEncounter(pool, { encounterId, signedBy: DOCTOR, content: { history: 'h', assessment: 'a', plan: 'p' } });
  assert.equal(res.status, 'signed');
});

test('the patient timeline assembles events chronologically with provenance and filtering (EHR-002)', { skip }, async () => {
  // Add an addendum to one of the signed encounters, and an observation.
  const enc = await pool.query(`SELECT id FROM clinical.encounter WHERE patient_id=$1 AND status='signed' LIMIT 1`, [PATIENT]);
  await addAddendum(pool, { encounterId: enc.rows[0].id, author: DOCTOR, content: { note: 'patient improving' } });
  await pool.query(
    `INSERT INTO clinical.observation (id, patient_id, kind, value, unit, flag, recorded_by) VALUES (gen_random_uuid(),$1,'temperature_c',38.4,'C','out_of_reference',$2)`,
    [PATIENT, DOCTOR],
  );

  const all = await patientTimeline(pool, PATIENT);
  assert.ok(all.length >= 3);
  // Chronological (non-decreasing timestamps).
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1]!.at <= all[i]!.at);
  // Provenance carried.
  assert.ok(all.every((i) => 'author' in i));
  assert.ok(all.some((i) => i.type === 'addendum'));
  assert.ok(all.some((i) => i.type === 'observation' && (i.flags ?? []).includes('out_of_reference')));

  // Filter by type.
  const obsOnly = await patientTimeline(pool, PATIENT, { type: 'observation' });
  assert.ok(obsOnly.length >= 1 && obsOnly.every((i) => i.type === 'observation'));
});
