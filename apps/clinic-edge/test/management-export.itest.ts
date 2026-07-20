/**
 * Management export (MGT-007, UAT-15) against real PostgreSQL. Proves: an export
 * carries the as-of time, filters and confidentiality label, contains the
 * dashboard, and is itself recorded as an audit event.
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
import { doCheckout } from '../src/api.ts';
import { exportDashboard } from '../src/management.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const MANAGER = '00000000-0000-7000-8000-0000000000ac';

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
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 3, chargeMinor: 300, paymentMinor: 200, paymentMethod: 'cash' });
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('a management export carries metadata, the dashboard, and is audited (UAT-15)', { skip }, async () => {
  const before = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='management_report'`);
  const exp = await exportDashboard(pool, { asOf: '2026-07-19', exportedBy: MANAGER, filters: { site: 'main' }, format: 'pdf' });

  assert.equal(exp.asOf, '2026-07-19');
  assert.equal(exp.confidentiality, 'management-only');
  assert.equal(exp.exportedBy, MANAGER);
  assert.equal(exp.format, 'pdf');
  assert.deepEqual(exp.filters, { site: 'main' });
  assert.ok(exp.dashboard.kpis.length > 0);
  assert.ok(exp.dashboard.exceptions.some((e) => e.type === 'debtors'));

  const after = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='management_report'`);
  assert.equal(after.rows[0].n, before.rows[0].n + 1);
});
