/**
 * Per-test database reset for E2E isolation: rebuilds the edge database from
 * migrations + synthetic seed and clears the cloud store, so each spec starts from
 * a known pristine state regardless of order.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

export async function resetDb(): Promise<void> {
  const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://sancta@127.0.0.1:5433/sancta_test';
  const CLOUD_DATABASE_URL = process.env['CLOUD_DATABASE_URL'] ?? 'postgres://sancta@127.0.0.1:5433/sancta_cloud';
  const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

  const edge = new pg.Client({ connectionString: DATABASE_URL });
  await edge.connect();
  await edge.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
  await edge.query(allMigrationsSql());
  await edge.query(seed);
  await edge.end();

  const cloud = new pg.Client({ connectionString: CLOUD_DATABASE_URL });
  await cloud.connect();
  try {
    await cloud.query(`DELETE FROM cloud.synced_checkout`);
    await cloud.query(`DELETE FROM cloud.applied_change`);
  } catch {
    /* cloud schema not yet created — nothing to clear */
  }
  await cloud.end();
}
