/**
 * Related persons (PAT-005) + restricted-record access (PAT-009) against real
 * PostgreSQL. Proves: guardians/emergency contacts are recorded and surfaced; and
 * access to a restricted record is denied without an authorised role or break-
 * glass, allowed (and audited) with them.
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
import { addRelatedPerson, listRelatedPersons, guardians, accessPatient, RelationError } from '../src/patient-relations.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const CLERK = '00000000-0000-7000-8000-0000000000c1';

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

test('guardians and emergency contacts are recorded and surfaced (PAT-005)', { skip }, async () => {
  await addRelatedPerson(pool, { patientId: PATIENT, name: 'Jane Alpha', relationship: 'mother', isGuardian: true, phone: '+100', by: CLERK });
  await addRelatedPerson(pool, { patientId: PATIENT, name: 'Uncle Bravo', relationship: 'other', isEmergencyContact: true, by: CLERK });
  await assert.rejects(addRelatedPerson(pool, { patientId: PATIENT, name: 'x', relationship: 'alien', by: CLERK }), RelationError);

  const related = await listRelatedPersons(pool, PATIENT);
  assert.ok(related.length >= 2);
  const g = await guardians(pool, PATIENT);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.name, 'Jane Alpha');
});

test('restricted-record access follows the authorisation matrix, audited (PAT-009)', { skip }, async () => {
  await pool.query(`UPDATE identity.patient SET sensitivity='restricted' WHERE id=$1`, [PATIENT]);

  // Reception (unauthorised for restricted) is denied.
  await assert.rejects(accessPatient(pool, { patientId: PATIENT, roles: ['reception'], user: CLERK }), /authorised role or break-glass/);
  // Clinical needs a purpose.
  await assert.rejects(accessPatient(pool, { patientId: PATIENT, roles: ['clinical'], user: CLERK }), /purpose/);
  const ok = await accessPatient(pool, { patientId: PATIENT, roles: ['clinical'], user: CLERK, purpose: 'treatment' });
  assert.equal(ok.allowed, true);

  // Break-glass lets an unauthorised role in with a reason (emergency).
  const bg = await accessPatient(pool, { patientId: PATIENT, roles: ['cashier'], user: CLERK, breakGlass: true, breakGlassReason: 'unconscious, emergency' });
  assert.equal(bg.breakGlass, true);

  // Both permitted accesses are audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='patient' AND resource_id=$1 AND action IN ('view','break_glass')`, [PATIENT]);
  assert.ok((audit.rows[0].n as number) >= 2);
});
