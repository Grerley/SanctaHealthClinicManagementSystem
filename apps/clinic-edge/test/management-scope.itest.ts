/**
 * Management scope, drill-through & commentary (MGT-002, MGT-006, MGT-010) against
 * real PostgreSQL. Proves: a site filter is constrained to the caller's authorised
 * scope; a drill to clinical/patient detail is denied to a non-clinical role and
 * the denial is audited; and KPI commentary is append-only history.
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
import { resolveSiteScope, drillThrough, addCommentary, listCommentary, ManagementScopeError } from '../src/management.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const MANAGER = '00000000-0000-7000-8000-0000000000c1';
const MAIN = '00000000-0000-7000-8000-0000000000f1'; // seeded central site
let BRANCH: string;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
    const r = await c.query(`INSERT INTO organisation.site (id, code, name, is_central) VALUES (gen_random_uuid(),'BRANCH','Branch clinic',false) RETURNING id`);
    BRANCH = r.rows[0].id;
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('a site filter is constrained to the caller scope (MGT-002)', { skip }, async () => {
  // Central role (manager) may narrow to any site.
  const central = await resolveSiteScope(pool, { roles: ['manager'], userSite: MAIN, requestedSites: [BRANCH] });
  assert.deepEqual(central.allowed, [BRANCH]);
  assert.deepEqual(central.rejected, []);

  // Local role (reception) at MAIN cannot see the branch — it is rejected as out of scope.
  const local = await resolveSiteScope(pool, { roles: ['reception'], userSite: MAIN, requestedSites: [MAIN, BRANCH] });
  assert.deepEqual(local.allowed, [MAIN]);
  assert.deepEqual(local.rejected, [BRANCH]);

  // No request → all accessible sites (central sees both).
  const all = await resolveSiteScope(pool, { roles: ['manager'], userSite: MAIN, requestedSites: [] });
  assert.equal(all.allowed.length, 2);
});

test('drill to patient detail is denied to a summary-only role and audited (MGT-006)', { skip }, async () => {
  // A clinical role may drill through.
  const ok = await drillThrough(pool, { roles: ['clinical'], target: 'patient_detail', actor: MANAGER });
  assert.equal(ok.permission, 'view_clinical_detail');

  // A manager sees summaries but must NOT reach patient detail via the dashboard.
  await assert.rejects(
    drillThrough(pool, { roles: ['manager'], target: 'patient_detail', actor: MANAGER }),
    ManagementScopeError,
  );
  const denied = await pool.query(
    `SELECT count(*)::int AS n FROM audit.audit_event WHERE action='access' AND resource_type='management_drill' AND outcome='deny'`,
  );
  assert.ok((denied.rows[0].n as number) >= 1);

  // Operational drill-through stays open to a manager.
  const ops = await drillThrough(pool, { roles: ['manager'], target: 'operational', actor: MANAGER });
  assert.equal(ops.target, 'operational');
});

test('KPI commentary is append-only history (MGT-010)', { skip }, async () => {
  await addCommentary(pool, { kpiId: 'charge_capture', period: '2026-07', commentary: 'Dropped after clinic closure', action: 'Backfill charges', actionOwner: MANAGER, dueDate: '2026-07-31', authoredBy: MANAGER });
  await addCommentary(pool, { kpiId: 'charge_capture', period: '2026-07', commentary: 'Backfill complete', authoredBy: MANAGER });

  const history = await listCommentary(pool, { kpiId: 'charge_capture', period: '2026-07' });
  assert.equal(history.length, 2); // both preserved — nothing overwritten
  assert.equal(history[0]!.commentary, 'Backfill complete'); // newest first
  assert.equal(history[1]!.action, 'Backfill charges');
  assert.equal(history[1]!.dueDate, '2026-07-31');

  // Empty commentary is rejected.
  await assert.rejects(addCommentary(pool, { kpiId: 'x', period: '2026-07', commentary: '  ' }), ManagementScopeError);
});
