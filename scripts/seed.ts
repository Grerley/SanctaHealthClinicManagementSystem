/**
 * Optional synthetic-data seed for demos and local testing. Loads
 * seed/synthetic-seed.sql into DATABASE_URL. REFUSES to run against a production
 * instance (INSTANCE_MODE=production) — production holds real data that must only
 * arrive via sync, never a synthetic seed (ADM-007, the no-synthetic-in-prod rule).
 *
 *   DATABASE_URL=postgres://… node --experimental-strip-types scripts/seed.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const mode = (process.env['INSTANCE_MODE'] ?? '').toLowerCase();
if (mode === 'production' || mode === 'prod') {
  console.error('Refusing to seed synthetic data into a production instance (INSTANCE_MODE=production).');
  process.exit(1);
}

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const seedSql = readFileSync(join(here, '..', 'seed', 'synthetic-seed.sql'), 'utf8');

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query(seedSql);
  console.log('Loaded synthetic seed data (non-production).');
} catch (e) {
  console.error(`Seed failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
