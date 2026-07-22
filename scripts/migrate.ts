/**
 * Forward-migration CLI. Applies pending migrations to the database named by
 * DATABASE_URL and records them in public.schema_migrations. Idempotent — run it
 * on every deploy (cloud or local edge) to bring the schema up to date.
 *
 *   DATABASE_URL=postgres://… node --experimental-strip-types scripts/migrate.ts
 */
import pg from 'pg';
import { applyMigrations } from '@sancta/db/migrations';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required (a PostgreSQL connection URL from your provider).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const { applied, alreadyApplied } = await applyMigrations(client, { log: (m) => console.log(`  ${m}`) });
  if (applied.length === 0) console.log(`Schema already up to date (${alreadyApplied} migration(s) applied previously).`);
  else console.log(`Applied ${applied.length} migration(s); ${alreadyApplied} were already applied.`);
} catch (e) {
  console.error(`Migration failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
