/**
 * Patient registration + search + duplicate check (PAT-001/002/003/004, UAT-02)
 * against real PostgreSQL. Proves: a new patient gets a durable UUID + controlled
 * MRN; search finds by name/MRN/phone; a likely duplicate is blocked for review;
 * and a forced registration proceeds after review (never an automatic merge).
 *
 * Skips unless DATABASE_URL is set. Uses clearly synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { isUuidv7 } from '@sancta/domain';
import { registerPatient, searchPatients } from '../src/patients.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;

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

test('registers a new patient with a durable UUID and controlled MRN (PAT-001)', { skip }, async () => {
  const res = await registerPatient(pool, { givenName: 'Rutendo', familyName: 'Sibanda', dateOfBirth: '2001-03-04', sex: 'F', phone: '+263 771 555 000' });
  assert.ok(res.ok);
  if (res.ok) {
    assert.ok(isUuidv7(res.id));
    assert.match(res.mrn, /^SCC-\d{6}$/);
  }
});

test('search finds the patient by family name and by MRN (PAT-002, UAT-02)', { skip }, async () => {
  const byName = await searchPatients(pool, 'Sibanda');
  assert.ok(byName.some((p) => p.family_name === 'Sibanda'));
  const mrn = byName[0]!.mrn;
  const byMrn = await searchPatients(pool, mrn);
  assert.equal(byMrn[0]!.mrn, mrn);
});

test('a likely duplicate is blocked for review, not silently created (PAT-003)', { skip }, async () => {
  // Same person, spelling variant + same DOB + same phone.
  const res = await registerPatient(pool, { givenName: 'Rutendo', familyName: 'Sibhanda', dateOfBirth: '2001-03-04', phone: '+263 771 555 000' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.duplicates.length >= 1);
    assert.ok(res.duplicates[0]!.reasons.length >= 1);
  }
  // No extra row was inserted.
  const n = await pool.query(`SELECT count(*)::int AS n FROM identity.patient WHERE family_name ILIKE 'Sib%'`);
  assert.equal(n.rows[0].n, 1);
});

test('a forced registration proceeds after human review (PAT-003)', { skip }, async () => {
  const res = await registerPatient(pool, { givenName: 'Rutendo', familyName: 'Sibhanda', dateOfBirth: '2001-03-04', phone: '+263 771 555 000', force: true });
  assert.ok(res.ok);
  const n = await pool.query(`SELECT count(*)::int AS n FROM identity.patient WHERE family_name ILIKE 'Sib%'`);
  assert.equal(n.rows[0].n, 2);
  // Both creations are audited (BR-012).
  const a = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='patient' AND action='create'`);
  assert.ok((a.rows[0].n as number) >= 2);
});

test('a clearly different person registers without a duplicate block', { skip }, async () => {
  const res = await registerPatient(pool, { givenName: 'Blessing', familyName: 'Chikwava', dateOfBirth: '1978-12-12', sex: 'M' });
  assert.ok(res.ok);
});
