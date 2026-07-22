/**
 * SQLite/D1 migrations loader. The .sql files in packages/d1/migrations are the
 * single source of truth: applied to production D1 by `wrangler d1 migrations
 * apply`, and to a LocalD1 in tests by `applyD1Migrations`. Forward-only, numbered.
 *
 * Files ending `_seed.sql` are synthetic demo data, not schema: wrangler still
 * applies them to production (so a fresh database is immediately clickable), but
 * `applyD1Migrations` applies SCHEMA ONLY so tests keep exact fixtures. Tests that
 * want the demo data call `applyD1Seeds` explicitly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Database } from './d1.ts';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function sqlFiles(): string[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
}

/** Schema migrations only (excludes `*_seed.sql`). */
export function migrationFiles(): string[] {
  return sqlFiles().filter((f) => !f.endsWith('_seed.sql'));
}

/** Synthetic seed files (`*_seed.sql`). */
export function seedFiles(): string[] {
  return sqlFiles().filter((f) => f.endsWith('_seed.sql'));
}

export function readMigration(file: string): string {
  return readFileSync(join(migrationsDir, file), 'utf8');
}

/** Apply the schema migrations to a database (tests + local dev). */
export async function applyD1Migrations(db: D1Database): Promise<void> {
  for (const f of migrationFiles()) {
    await db.exec(readMigration(f));
  }
}

/** Apply the synthetic demo seeds (opt-in; production gets these via wrangler). */
export async function applyD1Seeds(db: D1Database): Promise<void> {
  for (const f of seedFiles()) {
    await db.exec(readMigration(f));
  }
}
