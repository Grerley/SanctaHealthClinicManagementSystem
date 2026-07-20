/**
 * Staff productivity report (OPS-007) against real PostgreSQL. Proves activity is
 * counted from the audit trail per staff member, with a high-acuity complexity
 * signal, over a date window.
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
import { recordVitals, recordTriageAssessment, signTriage } from '../src/triage.ts';
import { staffProductivity } from '../src/ops.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const NURSE = '00000000-0000-7000-8000-0000000000e1';

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

test('productivity counts audited staff activity with a high-acuity signal (OPS-007)', { skip }, async () => {
  // A high-acuity triage handled by the nurse.
  const v = await recordVitals(pool, { patientId: PATIENT, vitals: [{ kind: 'spo2_pct', value: 85 }, { kind: 'respiratory_rate', value: 30 }], confirmed: true, user: NURSE });
  await recordTriageAssessment(pool, { encounterId: v.encounterId, reason: 'SOB', user: NURSE });
  await signTriage(pool, { encounterId: v.encounterId, signedBy: NURSE });

  const report = await staffProductivity(pool, { from: '2026-01-01', to: '2027-01-01' });
  const nurse = report.find((r) => r.staffId === NURSE)!;
  assert.ok(nurse, 'nurse should appear in the report');
  assert.ok(nurse.total >= 2); // triage create + sign at least
  assert.ok(nurse.actions['sign']! >= 1);
  assert.equal(nurse.highAcuityTriage, 1);

  // A window before the activity captures nothing.
  const empty = await staffProductivity(pool, { from: '2025-01-01', to: '2025-02-01' });
  assert.ok(!empty.some((r) => r.staffId === NURSE));
});
