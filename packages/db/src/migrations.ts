/**
 * Migration loader (NFR-024). Reads the forward-only SQL migrations in order so
 * the edge and cloud apply an identical schema. A real runner records applied
 * versions; tests and the e2e harness use `allMigrationsSql()` to build a fresh
 * database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 0001_, 0002_, … lexical order == apply order
}

/** All migrations concatenated in order — apply once to a clean database. */
export function allMigrationsSql(): string {
  return migrationFiles()
    .map((f) => `-- ${f}\n${readFileSync(join(migrationsDir, f), 'utf8')}`)
    .join('\n');
}

/** Read a single migration file's SQL by name. */
export function readMigration(file: string): string {
  return readFileSync(join(migrationsDir, file), 'utf8');
}

/** Minimal client shape (structurally satisfied by a `pg` Client/Pool). */
export interface MigrateClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

// Migration files manage their own top-level BEGIN/COMMIT in some cases; the
// runner wraps every file in its own transaction, so strip the standalone
// transaction-control lines to avoid a nested-transaction COMMIT closing the
// wrapper early. Only exact `BEGIN;` / `COMMIT;` lines are removed.
function stripTxnControl(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => {
      const t = line.trim().toUpperCase();
      return t !== 'BEGIN;' && t !== 'COMMIT;';
    })
    .join('\n');
}

/**
 * Apply pending forward-only migrations to a live database (NFR-024). Each
 * migration runs in its own transaction and is recorded in
 * `public.schema_migrations`; already-applied migrations are skipped. Safe to run
 * repeatedly (idempotent) — this is how the edge and cloud databases are brought
 * up to schema in production, without the test harness's drop-and-rebuild.
 */
export async function applyMigrations(
  client: MigrateClient,
  opts: { log?: (message: string) => void } = {},
): Promise<{ applied: string[]; alreadyApplied: number }> {
  const log = opts.log ?? (() => {});
  await client.query(
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
       filename   text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await client.query(`SELECT filename FROM public.schema_migrations`)).rows.map((r) => r['filename'] as string),
  );
  const files = migrationFiles();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = stripTxnControl(readMigration(f));
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(`INSERT INTO public.schema_migrations (filename) VALUES ($1)`, [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${f} failed and was rolled back: ${(e as Error).message}`);
    }
    log(`applied ${f}`);
    applied.push(f);
  }
  return { applied, alreadyApplied: files.length - applied.length };
}
