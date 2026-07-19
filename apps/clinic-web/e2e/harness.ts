/**
 * E2E harness: boots a genuine offline-first stack for the Playwright run —
 * real edge PostgreSQL + the durable cloud adapter + the clinic-edge server
 * serving the built PWA and LAN API. Reset + seed are applied here so each run
 * is deterministic and uses only synthetic data.
 *
 * Started by playwright.config.ts `webServer`. Ready when /healthz responds.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { startCloudAdapter } from '@sancta/cloud-worker/node-adapter';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const webDist = join(here, '..', 'dist');

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://sancta@127.0.0.1:5433/sancta_test';
const CLOUD_DATABASE_URL = process.env['CLOUD_DATABASE_URL'] ?? 'postgres://sancta@127.0.0.1:5433/sancta_cloud';
const EDGE_PORT = process.env['EDGE_PORT'] ?? '8791';

async function main(): Promise<void> {
  const migration = allMigrationsSql();
  const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

  // Reset the edge database.
  const edge = new pg.Client({ connectionString: DATABASE_URL });
  await edge.connect();
  await edge.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
  await edge.query(migration);
  await edge.query(seed);
  await edge.end();

  // Reset the cloud store.
  const cloud = new pg.Client({ connectionString: CLOUD_DATABASE_URL });
  await cloud.connect();
  await cloud.query(`DROP SCHEMA IF EXISTS cloud CASCADE;`);
  await cloud.end();

  const adapter = await startCloudAdapter(CLOUD_DATABASE_URL);

  // Configure and start the edge server (env must be set before importing it).
  process.env['DATABASE_URL'] = DATABASE_URL;
  process.env['CLOUD_INGRESS_URL'] = adapter.url;
  process.env['WEB_DIST'] = webDist;
  process.env['EDGE_PORT'] = EDGE_PORT;
  const { server } = await import('@sancta/clinic-edge/server');
  server.listen(Number(EDGE_PORT), () => {
    // eslint-disable-next-line no-console
    console.log(`[harness] edge on http://127.0.0.1:${EDGE_PORT}  cloud=${adapter.url}  web=${webDist}`);
  });
}

void main();
