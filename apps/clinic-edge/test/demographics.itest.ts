/**
 * Configurable demographic capture policy (PAT-004) against real PostgreSQL.
 * Proves: registration enforces the mandatory-field policy; a mandatory field may
 * be satisfied by a permitted unknown/declined marker (never silently skipped);
 * markers are retained on the patient; and the policy is administrable (a config
 * change tightens what registration will accept).
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
import { DemographicError } from '@sancta/domain';
import { registerPatient } from '../src/patients.ts';
import { listPolicy, setFieldRule } from '../src/demographics.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
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

test('the default capture policy is present (PAT-004)', { skip }, async () => {
  const fields = await listPolicy(pool);
  const dob = fields.find((f) => f.field === 'date_of_birth')!;
  assert.equal(dob.required, true);
  assert.equal(dob.allowUnknown, true);
  const family = fields.find((f) => f.field === 'family_name')!;
  assert.equal(family.required, true);
  assert.equal(family.allowUnknown, false);
});

test('registration rejects a missing mandatory field (PAT-004)', { skip }, async () => {
  // date_of_birth is mandatory and no value/marker is supplied.
  await assert.rejects(
    registerPatient(pool, { givenName: 'Newone', familyName: 'Alpha', force: true, user: ADMIN }),
    DemographicError,
  );
});

test('a mandatory field is satisfied by a permitted marker, which is retained (PAT-004)', { skip }, async () => {
  const res = await registerPatient(pool, { givenName: 'Estimated', familyName: 'Age', markers: { date_of_birth: 'unknown' }, force: true, user: ADMIN });
  assert.ok(res.ok && res.id);
  const row = await pool.query(`SELECT date_of_birth, demographic_markers FROM identity.patient WHERE id=$1`, [(res as { id: string }).id]);
  assert.equal(row.rows[0].date_of_birth, null);
  assert.equal(row.rows[0].demographic_markers.date_of_birth, 'unknown');
});

test('a marker not permitted for a field is rejected (PAT-004)', { skip }, async () => {
  // family_name does not allow "unknown".
  await assert.rejects(
    registerPatient(pool, { givenName: 'X', markers: { family_name: 'unknown', date_of_birth: 'unknown' }, force: true, user: ADMIN }),
    /family_name/,
  );
});

test('the policy is administrable and tightens registration (PAT-004)', { skip }, async () => {
  // A plain given+family+DOB registration is currently accepted.
  const ok = await registerPatient(pool, { givenName: 'Sex', familyName: 'Optional', dateOfBirth: '1990-01-01', force: true, user: ADMIN });
  assert.ok(ok.ok);

  // Make sex mandatory; now the same shape without sex is refused.
  await setFieldRule(pool, { field: 'sex', required: true, allowUnknown: true, displayOrder: 40, by: ADMIN });
  await assert.rejects(
    registerPatient(pool, { givenName: 'Sex2', familyName: 'Missing', dateOfBirth: '1990-01-01', force: true, user: ADMIN }),
    /sex/,
  );
  // Supplying sex (or its permitted marker) satisfies the tightened policy.
  const ok2 = await registerPatient(pool, { givenName: 'Sex3', familyName: 'Given', dateOfBirth: '1990-01-01', markers: { sex: 'unknown' }, force: true, user: ADMIN });
  assert.ok(ok2.ok);

  // The config change is audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE action='config' AND resource_type='demographic_field' AND reason LIKE '%sex%'`);
  assert.ok((audit.rows[0].n as number) >= 1);
});
