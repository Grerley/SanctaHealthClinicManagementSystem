/**
 * Prescribing with allergy check + controlled override (MED-003, UAT-05) against
 * real PostgreSQL. Proves: prescribing against an active allergy is blocked and
 * returns the alert; override without a reason is rejected; override with a reason
 * proceeds and is recorded/audited; a medicine with no allergy prescribes freely.
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
import { recordAllergy, prescribe, PrescribingError } from '../src/prescribing.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const PRESCRIBER = '00000000-0000-7000-8000-0000000000e1';

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
  await recordAllergy(pool, { patientId: PATIENT, substanceCode: 'PENICILLIN', severity: 'critical' });
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('prescribing against an active allergy is blocked with the alert (MED-003, UAT-05)', { skip }, async () => {
  const res = await prescribe(pool, { patientId: PATIENT, medicineCode: 'AMOX-500', substanceCode: 'PENICILLIN', dose: '500mg', route: 'oral', prescribedBy: PRESCRIBER });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.alerts[0]!.substanceCode, 'PENICILLIN');
    assert.equal(res.alerts[0]!.severity, 'critical');
  }
  // Nothing was written.
  const n = await pool.query(`SELECT count(*)::int AS n FROM clinical.medication_request`);
  assert.equal(n.rows[0].n, 0);
});

test('override requires a reason', { skip }, async () => {
  await assert.rejects(
    prescribe(pool, { patientId: PATIENT, medicineCode: 'AMOX-500', substanceCode: 'PENICILLIN', prescribedBy: PRESCRIBER, override: true }),
    PrescribingError,
  );
});

test('override with a reason proceeds and is recorded/audited (UAT-05)', { skip }, async () => {
  const res = await prescribe(pool, { patientId: PATIENT, medicineCode: 'AMOX-500', substanceCode: 'PENICILLIN', prescribedBy: PRESCRIBER, override: true, overrideReason: 'mild historical rash; benefit outweighs risk' });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.overridden, true);
  const mr = await pool.query(`SELECT override_reason, override_by FROM clinical.medication_request WHERE substance_code='PENICILLIN'`);
  assert.match(mr.rows[0].override_reason, /benefit outweighs risk/);
  assert.equal(mr.rows[0].override_by, PRESCRIBER);
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='medication_request' AND reason LIKE 'allergy override%'`);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('a medicine with no matching allergy prescribes freely', { skip }, async () => {
  const res = await prescribe(pool, { patientId: PATIENT, medicineCode: 'PARA-500', substanceCode: 'PARACETAMOL', dose: '1g', prescribedBy: PRESCRIBER });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.overridden, false);
});
