/**
 * Privacy views & authorised disclosure (VIS-009, MGT-009, PAT-010) against real
 * PostgreSQL. Proves: the public queue carries no patient identity; the analytical
 * extract is pseudonymous and age-banded (no exact DOB); and a patient-summary
 * export requires a purpose and is written to an append-only disclosure log.
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
import { publicQueue, analyticalExtract, exportPatientSummary, listPatientDisclosures, DisclosureError } from '../src/privacy.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
let PATIENT: string;
let PATIENT_NAME: string;
const CLERK = '00000000-0000-7000-8000-0000000000b1';

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
    const r = await c.query(`SELECT id, given_name, family_name FROM identity.patient ORDER BY id LIMIT 1`);
    PATIENT = r.rows[0].id;
    PATIENT_NAME = `${r.rows[0].given_name ?? ''} ${r.rows[0].family_name ?? ''}`.trim();
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('the public queue carries no patient identity (VIS-009)', { skip }, async () => {
  await startVisit(pool, { patientId: PATIENT, station: 'triage' });
  const q = await publicQueue(pool, '2026-07-21T09:00:00Z');
  assert.ok(q.length >= 1);
  const entry = q[0]!;
  assert.match(entry.token, /^T\d{3}$/);
  // The serialised queue must not contain the patient's id or name.
  const whole = JSON.stringify(q).toLowerCase();
  assert.ok(!whole.includes(PATIENT.toLowerCase()));
  if (PATIENT_NAME) assert.ok(!whole.includes(PATIENT_NAME.toLowerCase().split(' ')[0]!));
  assert.ok(!('patientId' in entry));
});

test('the analytical extract is pseudonymous and age-banded (MGT-009)', { skip }, async () => {
  const ex = await analyticalExtract(pool, { asOf: '2026-07-21', exportedBy: CLERK });
  assert.ok(ex.rowCount >= 1);
  const rec = ex.records[0]!;
  assert.match(rec.pseudoId, /^p-[0-9a-f]{16}$/); // pseudonym, not the real id
  assert.ok(['0-4', '5-14', '15-24', '25-34', '35-44', '45-54', '55-64', '65+', 'unknown'].includes(rec.ageBand));
  // No real patient id or exact DOB survives.
  const whole = JSON.stringify(ex.records);
  assert.ok(!whole.includes(PATIENT));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(whole)); // no ISO dates (exact DOB) leaked

  // The export is audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE action='export' AND resource_type='analytical_dataset'`);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('a patient-summary export requires a purpose and is logged (PAT-010)', { skip }, async () => {
  // A purpose is mandatory.
  await assert.rejects(exportPatientSummary(pool, { patientId: PATIENT, purpose: '  ' }), DisclosureError);

  const out = await exportPatientSummary(pool, { patientId: PATIENT, purpose: 'Patient requested copy', recipient: 'the patient', format: 'print', disclosedBy: CLERK });
  assert.equal(out.summary.patient.id, PATIENT);
  assert.equal(out.contentHash.length, 64);

  const log = await listPatientDisclosures(pool, { patientId: PATIENT });
  assert.equal(log.length, 1);
  assert.equal(log[0]!.purpose, 'Patient requested copy');
  assert.equal(log[0]!.recipient, 'the patient');

  // The disclosure is also audited against the patient.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE action='export' AND resource_type='patient_summary' AND patient_ref=$1`, [PATIENT]);
  assert.ok((audit.rows[0].n as number) >= 1);

  // Unknown patient rejected.
  await assert.rejects(exportPatientSummary(pool, { patientId: '00000000-0000-7000-8000-0000000000ff', purpose: 'x' }), DisclosureError);
});
