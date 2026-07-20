/**
 * FHIR-compatible read layer (SYN-009) against real PostgreSQL. Proves the edge
 * projects real patient rows onto FHIR R4 Patient resources and a searchset Bundle.
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
import { fhirPatientById, fhirPatientSearch } from '../src/fhir.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';

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

test('reads a real patient as a FHIR Patient resource (SYN-009)', { skip }, async () => {
  const f = await fhirPatientById(pool, PATIENT);
  assert.ok(f);
  assert.equal(f!.resourceType, 'Patient');
  assert.equal(f!.identifier?.[0]?.value, 'SCC-000101');
  assert.equal(f!.name?.[0]?.family, 'Alpha');
  assert.equal(f!.gender, 'female');
  assert.equal(f!.birthDate, '1990-05-01');
  assert.equal(await fhirPatientById(pool, '00000000-0000-7000-8000-0000000009ff'), null);
});

test('searches patients by identifier into a bundle (SYN-009)', { skip }, async () => {
  const results = await fhirPatientSearch(pool, 'SCC-0001');
  assert.ok(results.length >= 2);
  assert.ok(results.every((r) => r.resourceType === 'Patient'));
});
