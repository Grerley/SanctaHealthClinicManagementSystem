/**
 * Multi-site registry + scoped visibility (OPS-008) against real PostgreSQL.
 * Proves the authorisation matrix in practice: a central role sees every site;
 * a local user sees only their own.
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
import { registerSite, listSitesForUser, SiteError } from '../src/site.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const MAIN = '00000000-0000-7000-8000-0000000000f1';

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

test('central roles see the whole network; local users see only their site (OPS-008)', { skip }, async () => {
  const branch = await registerSite(pool, { code: 'BR1', name: 'Branch clinic' });
  await assert.rejects(registerSite(pool, { code: '', name: 'x' }), SiteError);

  // Central role (manager): all sites.
  const central = await listSitesForUser(pool, ['manager'], MAIN);
  assert.ok(central.length >= 2);
  assert.ok(central.some((s) => s.id === branch.id) && central.some((s) => s.id === MAIN));

  // Local clinical user at MAIN: only MAIN.
  const local = await listSitesForUser(pool, ['clinical'], MAIN);
  assert.equal(local.length, 1);
  assert.equal(local[0]!.id, MAIN);

  // Local user at the branch: only the branch.
  const atBranch = await listSitesForUser(pool, ['reception'], branch.id);
  assert.equal(atBranch.length, 1);
  assert.equal(atBranch[0]!.id, branch.id);

  // A local user with no site sees nothing.
  assert.equal((await listSitesForUser(pool, ['stock'], null)).length, 0);
});
