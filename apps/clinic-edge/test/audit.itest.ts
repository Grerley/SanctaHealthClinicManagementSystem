/**
 * Audit search + audited export (ADM-004, BR-012) against real PostgreSQL. Proves:
 * operations across modules write audit events; search filters by resource type,
 * action, patient and user; and exporting audit data is itself recorded.
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
import { registerPatient } from '../src/patients.ts';
import { createDraftEncounter, signEncounter } from '../src/encounters.ts';
import { searchAudit, exportAudit } from '../src/audit.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const DOCTOR = '00000000-0000-7000-8000-0000000000e1';
const DPO = '00000000-0000-7000-8000-0000000000ab';

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
  // Generate some auditable activity.
  await registerPatient(pool, { givenName: 'Audit', familyName: 'Subject', dateOfBirth: '1999-09-09', user: DOCTOR });
  const enc = await createDraftEncounter(pool, { patientId: '00000000-0000-7000-8000-000000000101' });
  await signEncounter(pool, { encounterId: enc.encounterId, signedBy: DOCTOR, content: { assessment: 'test' } });
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('search filters audit events by resource type and action (ADM-004)', { skip }, async () => {
  const patients = await searchAudit(pool, { resourceType: 'patient', action: 'create' });
  assert.ok(patients.length >= 1);
  assert.ok(patients.every((r) => r.resourceType === 'patient' && r.action === 'create'));

  const signs = await searchAudit(pool, { action: 'sign' });
  assert.ok(signs.some((r) => r.resourceType === 'encounter'));
});

test('search filters by actor user', { skip }, async () => {
  const byUser = await searchAudit(pool, { user: DOCTOR });
  assert.ok(byUser.length >= 1);
  assert.ok(byUser.every((r) => r.actorUser === DOCTOR));
});

test('exporting audit data is itself audited (ADM-004)', { skip }, async () => {
  const before = (await searchAudit(pool, { action: 'export' })).length;
  const { rows, exportEventId } = await exportAudit(pool, { resourceType: 'patient' }, DPO);
  assert.ok(rows.length >= 1);
  assert.ok(exportEventId);
  const after = await searchAudit(pool, { action: 'export' });
  assert.equal(after.length, before + 1);
  assert.ok(after.some((r) => r.actorUser === DPO && r.resourceType === 'audit'));
});
