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
