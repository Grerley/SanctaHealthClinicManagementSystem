/**
 * SQLite/D1 migrations loader. The .sql files in packages/d1/migrations are the
 * single source of truth: applied to production D1 by `wrangler d1 migrations
 * apply`, and to a LocalD1 in tests by `applyD1Migrations`. Forward-only, numbered.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Database } from './d1.ts';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function readMigration(file: string): string {
  return readFileSync(join(migrationsDir, file), 'utf8');
}

/** Apply every migration to a database (tests + local dev). */
export async function applyD1Migrations(db: D1Database): Promise<void> {
  for (const f of migrationFiles()) {
    await db.exec(readMigration(f));
  }
}
