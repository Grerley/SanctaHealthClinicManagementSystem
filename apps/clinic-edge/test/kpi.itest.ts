/**
 * KPI targets & period comparison (MGT-004, MGT-005) against real PostgreSQL.
 * Proves: targets are effective-dated config; a value bands green/amber/red
 * against the effective thresholds; and a current period compares to the prior
 * with a delta + trend.
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
import { setKpiTarget, recordSnapshot, kpiComparison, KpiAdminError } from '../src/kpi.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const MANAGER = '00000000-0000-7000-8000-0000000000c1';

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

test('KPI targets are effective-dated and version forward (MGT-004)', { skip }, async () => {
  const v1 = await setKpiTarget(pool, { kpiId: 'charge_capture', effectiveFrom: '2026-01-01', target: 100, warnAt: 90, critAt: 80, direction: 'higher_better', by: MANAGER });
  assert.equal(v1.version, 1);
  const v2 = await setKpiTarget(pool, { kpiId: 'charge_capture', effectiveFrom: '2026-07-01', target: 100, warnAt: 95, critAt: 85, direction: 'higher_better', by: MANAGER });
  assert.equal(v2.version, 2);
  await assert.rejects(setKpiTarget(pool, { kpiId: 'charge_capture', effectiveFrom: '2026-05-01', by: MANAGER }), /must be after/);
  // The config change is audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE action='config' AND resource_type='kpi_target' AND reason LIKE '%charge_capture%'`);
  assert.ok((audit.rows[0].n as number) >= 2);
});

test('current period compares to prior with delta, trend and RAG band (MGT-005)', { skip }, async () => {
  // Reuses the charge_capture v2 target from the previous test (effective 2026-07-01, warn 95).
  await recordSnapshot(pool, { kpiId: 'charge_capture', period: '2026-06', value: 88 });
  await recordSnapshot(pool, { kpiId: 'charge_capture', period: '2026-07', value: 97 });

  const cmp = await kpiComparison(pool, { kpiId: 'charge_capture', period: '2026-07', priorPeriod: '2026-06' });
  assert.equal(cmp.current, 97);
  assert.equal(cmp.prior, 88);
  assert.equal(cmp.delta, 9);
  assert.equal(cmp.trend, 'up');
  assert.equal(cmp.band.colour, 'green'); // 97 >= warnAt 95
  assert.ok(cmp.refreshedAt);

  // Missing current snapshot → not available.
  await assert.rejects(kpiComparison(pool, { kpiId: 'charge_capture', period: '2099-01', priorPeriod: '2026-07' }), KpiAdminError);
});

test('a snapshot upserts per period (MGT-005)', { skip }, async () => {
  await recordSnapshot(pool, { kpiId: 'visits', period: '2026-07', value: 10 });
  await recordSnapshot(pool, { kpiId: 'visits', period: '2026-07', value: 25 }); // overwrite
  const r = await pool.query(`SELECT value FROM organisation.kpi_snapshot WHERE kpi_id='visits' AND period='2026-07'`);
  assert.equal(r.rowCount, 1);
  assert.equal(Number(r.rows[0].value), 25);
});
