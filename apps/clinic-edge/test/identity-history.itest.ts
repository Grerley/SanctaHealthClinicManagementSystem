/**
 * Patient identity history & deceased provenance (PAT-007) + audit immutability
 * (NFR-016) against real PostgreSQL. Proves: a demographic change preserves the
 * previous value with provenance; death is recorded with a date + recorder and
 * cannot be recorded twice; the full history is retained; and the audit log
 * rejects UPDATE/DELETE at the database level.
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
import { changeDemographic, markDeceased, patientIdentityHistory, IdentityHistoryError } from '../src/identity-history.ts';

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

test('a name change preserves the previous value with provenance (PAT-007)', { skip }, async () => {
  const res = await changeDemographic(pool, { patientId: PATIENT, field: 'family_name', newValue: 'Alpha-Married', reason: 'marriage', by: CLERK });
  assert.equal(res.oldValue, 'Alpha');
  assert.equal(res.newValue, 'Alpha-Married');

  const live = await pool.query(`SELECT family_name FROM identity.patient WHERE id=$1`, [PATIENT]);
  assert.equal(live.rows[0].family_name, 'Alpha-Married');

  const history = await patientIdentityHistory(pool, PATIENT);
  const entry = history.find((h) => h.field === 'family_name')!;
  assert.equal(entry.oldValue, 'Alpha');
  assert.equal(entry.newValue, 'Alpha-Married');
  assert.equal(entry.reason, 'marriage');
  assert.equal(entry.changedBy, CLERK);
});

test('an unknown field is rejected (PAT-007)', { skip }, async () => {
  await assert.rejects(changeDemographic(pool, { patientId: PATIENT, field: 'mrn' as never, newValue: 'x', by: CLERK }), IdentityHistoryError);
});

test('death is recorded with a date + recorder and cannot repeat (PAT-007)', { skip }, async () => {
  const res = await markDeceased(pool, { patientId: PATIENT, deceasedAt: '2026-07-15', reason: 'reported by family', by: CLERK });
  assert.equal(res.deceasedAt, '2026-07-15');
  const row = await pool.query(`SELECT deceased, to_char(deceased_at,'YYYY-MM-DD') AS d, deceased_recorded_by FROM identity.patient WHERE id=$1`, [PATIENT]);
  assert.equal(row.rows[0].deceased, true);
  assert.equal(row.rows[0].d, '2026-07-15');
  assert.equal(row.rows[0].deceased_recorded_by, CLERK);
  await assert.rejects(markDeceased(pool, { patientId: PATIENT, deceasedAt: '2026-07-16', by: CLERK }), /already recorded/);

  const history = await patientIdentityHistory(pool, PATIENT);
  assert.ok(history.some((h) => h.field === 'deceased' && h.newValue === '2026-07-15'));
});

test('the audit log is append-only at the database level (NFR-016)', { skip }, async () => {
  // There are audit rows from the changes above.
  const before = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event`);
  assert.ok((before.rows[0].n as number) > 0);
  await assert.rejects(pool.query(`UPDATE audit.audit_event SET outcome='tampered'`), /append-only/);
  await assert.rejects(pool.query(`DELETE FROM audit.audit_event`), /append-only/);
  const after = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE outcome='tampered'`);
  assert.equal(after.rows[0].n, 0);
});
