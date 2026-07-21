/**
 * Patient card / QR & reception check-in view (PAT-006, VIS-002) against real
 * PostgreSQL. Proves: the card QR is PHI-free and resolves back to the patient;
 * the check-in view shows identity, tasks and balance but never clinical detail.
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
import { startVisit } from '../src/visits.ts';
import { patientCard, resolveCard, checkInView, FrontDeskError } from '../src/frontdesk.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
let PATIENT: string;
let PATIENT_GIVEN: string;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
    const r = await c.query(`SELECT id, given_name FROM identity.patient ORDER BY id LIMIT 1`);
    PATIENT = r.rows[0].id;
    PATIENT_GIVEN = String(r.rows[0].given_name ?? '');
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('the patient card QR is PHI-free and resolves back to the patient (PAT-006)', { skip }, async () => {
  const card = await patientCard(pool, PATIENT);
  assert.equal(card.qr, 'SANCTA:PT:' + PATIENT);
  // The QR contains only the opaque reference — no name.
  if (PATIENT_GIVEN) assert.ok(!card.qr.toLowerCase().includes(PATIENT_GIVEN.toLowerCase()));

  const resolved = await resolveCard(pool, card.qr);
  assert.equal(resolved.patientId, PATIENT);

  // A foreign or malformed code is rejected.
  await assert.rejects(resolveCard(pool, 'OTHER:123'), FrontDeskError);
  await assert.rejects(resolveCard(pool, 'SANCTA:PT:00000000-0000-7000-8000-0000000000ff'), FrontDeskError);
});

test('the check-in view shows tasks/balance but no clinical detail (VIS-002)', { skip }, async () => {
  const { visitId } = await startVisit(pool, { patientId: PATIENT, station: 'reception' });
  const view = await checkInView(pool, visitId);

  assert.equal(view.patient.patientId, PATIENT);
  assert.equal(typeof view.accountBalanceMinor, 'number');
  assert.ok(view.tasks.length >= 1);
  assert.equal(view.clinicalDetailIncluded, false);

  // The serialised view must not carry clinical fields.
  const whole = JSON.stringify(view).toLowerCase();
  for (const forbidden of ['diagnosis', 'encounter', 'result', 'allergy', 'medication', 'vitals']) {
    assert.ok(!whole.includes(forbidden), `check-in view leaked clinical field: ${forbidden}`);
  }

  await assert.rejects(checkInView(pool, '00000000-0000-7000-8000-0000000000ff'), FrontDeskError);
});
