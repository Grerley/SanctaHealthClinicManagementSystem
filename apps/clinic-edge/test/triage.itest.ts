/**
 * Triage / vitals capture (TRI-002/003, UAT-03) against real PostgreSQL. Proves:
 * a normal vitals set records with ok flags; an implausible value is rejected
 * until confirmed (never silently dropped); once confirmed it is stored with its
 * value and an 'implausible' flag; observations persist against the encounter.
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
import { VitalError } from '@sancta/domain';
import { recordVitals } from '../src/triage.ts';

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

async function obsCount(): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM clinical.observation`);
  return r.rows[0].n as number;
}

test('a normal vitals set records with ok flags', { skip }, async () => {
  const res = await recordVitals(pool, {
    patientId: PATIENT,
    vitals: [{ kind: 'temperature_c', value: 36.8 }, { kind: 'pulse_bpm', value: 74 }, { kind: 'spo2_pct', value: 98 }],
  });
  assert.ok(res.observations.every((o) => o.flag === 'ok'));
  assert.equal(await obsCount(), 3);
});

test('an implausible value is rejected until confirmed and nothing is written (UAT-03)', { skip }, async () => {
  const before = await obsCount();
  await assert.rejects(
    recordVitals(pool, { patientId: PATIENT, vitals: [{ kind: 'temperature_c', value: 350 }, { kind: 'pulse_bpm', value: 80 }] }),
    VitalError,
  );
  assert.equal(await obsCount(), before, 'nothing persisted on a rejected set');
});

test('once confirmed, the implausible value is stored with its flag (not dropped)', { skip }, async () => {
  const before = await obsCount();
  const res = await recordVitals(pool, {
    patientId: PATIENT,
    vitals: [{ kind: 'temperature_c', value: 350 }, { kind: 'pulse_bpm', value: 80 }],
    confirmed: true,
  });
  assert.equal(await obsCount(), before + 2);
  const stored = await pool.query(`SELECT value, flag, confirmed FROM clinical.observation WHERE kind='temperature_c' AND value=350`);
  assert.equal(Number(stored.rows[0].value), 350);
  assert.equal(stored.rows[0].flag, 'implausible');
  assert.equal(stored.rows[0].confirmed, true);
  assert.equal(res.observations[0]!.requiresConfirmation, true);
});

test('an out-of-reference but plausible value records without confirmation', { skip }, async () => {
  const res = await recordVitals(pool, { patientId: PATIENT, vitals: [{ kind: 'systolic_bp', value: 150 }] });
  assert.equal(res.observations[0]!.flag, 'out_of_reference');
});
