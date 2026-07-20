/**
 * Config releases, feature flags & system health (ADM-003/005/006) against real
 * PostgreSQL. Proves: a config release moves draft→test→approved (maker-checker)
 * →published, supersedes the prior and rolls back; feature flags gate by site/role;
 * and the health report aggregates operational signals.
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
import { createRelease, promoteRelease, rollbackRelease, currentConfig, setFeatureFlag, evaluateFlag, systemHealth, AdminError } from '../src/admin.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const MAKER = '00000000-0000-7000-8000-0000000000a1';
const CHECKER = '00000000-0000-7000-8000-0000000000a2';

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

test('a config release moves through its lifecycle with maker-checker (ADM-003)', { skip }, async () => {
  const r1 = await createRelease(pool, { name: 'fee-schedule', payload: { v: 1 }, by: MAKER });
  await promoteRelease(pool, { id: r1.id, to: 'test', by: MAKER });
  await assert.rejects(promoteRelease(pool, { id: r1.id, to: 'approved', by: MAKER }), /segregation/); // checker != maker
  await promoteRelease(pool, { id: r1.id, to: 'approved', by: CHECKER });
  await promoteRelease(pool, { id: r1.id, to: 'published', by: CHECKER });
  assert.equal((await currentConfig(pool, 'fee-schedule'))!.version, 1);
  await assert.rejects(promoteRelease(pool, { id: r1.id, to: 'draft', by: CHECKER }), /cannot move a published/);
});

test('publishing a new release supersedes the prior and rollback restores it (ADM-003)', { skip }, async () => {
  const r2 = await createRelease(pool, { name: 'fee-schedule', payload: { v: 2 }, by: MAKER });
  await promoteRelease(pool, { id: r2.id, to: 'test', by: MAKER });
  await promoteRelease(pool, { id: r2.id, to: 'approved', by: CHECKER });
  await promoteRelease(pool, { id: r2.id, to: 'published', by: CHECKER });
  assert.equal((await currentConfig(pool, 'fee-schedule'))!.version, 2); // v2 now live

  const rb = await rollbackRelease(pool, { name: 'fee-schedule', by: CHECKER });
  assert.ok(rb.published);
  assert.equal((await currentConfig(pool, 'fee-schedule'))!.version, 1); // v1 restored
});

test('feature flags gate by site and role (ADM-006)', { skip }, async () => {
  await setFeatureFlag(pool, { key: 'new_dashboard', enabled: true, sites: ['SITE-A'], roles: ['manager'] });
  assert.equal(await evaluateFlag(pool, 'new_dashboard', { site: 'SITE-A', roles: ['manager'] }), true);
  assert.equal(await evaluateFlag(pool, 'new_dashboard', { site: 'SITE-B', roles: ['manager'] }), false);
  assert.equal(await evaluateFlag(pool, 'new_dashboard', { site: 'SITE-A', roles: ['clinical'] }), false);
  assert.equal(await evaluateFlag(pool, 'unknown_flag', { site: 'SITE-A', roles: ['manager'] }), false);
});

test('system health aggregates operational signals (ADM-005)', { skip }, async () => {
  const h = await systemHealth(pool);
  assert.equal(h.database, 'ok');
  assert.equal(h.status, 'ok'); // clean system
  assert.equal(typeof h.pendingSync, 'number');
  assert.ok('queued' in h.integrationQueue && 'dead' in h.integrationQueue);
  assert.ok(h.checkedAt);

  // Introduce an open conflict → health flags attention.
  await pool.query(`INSERT INTO security_sync.conflict_case (id, entity_type, entity_id, status, local_version, incoming_version) VALUES (gen_random_uuid(),'patient',gen_random_uuid(),'open','{}','{}')`);
  assert.equal((await systemHealth(pool)).status, 'attention');
});
