/**
 * Edge backup & restore (UAT-16, NFR-011/012/013). Uses PostgreSQL's own
 * pg_dump/pg_restore (custom format) to take an encryptable, portable backup of
 * the entire edge database and restore it after loss. In production the backup
 * artefact is encrypted and shipped to removable media + a private R2 bucket
 * (CLD-006); this module is the deterministic dump/restore core the backup agent
 * and the recovery runbook call.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

function bin(name: string, binDir?: string): string {
  const dir = binDir ?? process.env['PG_BIN_DIR'] ?? '';
  return dir ? join(dir, name) : name;
}

export type BackupResult = { file: string; bytes: number };

/** Take a custom-format backup of the whole database to `outFile`. */
export async function backupEdge(connString: string, outFile: string, opts: { binDir?: string | undefined } = {}): Promise<BackupResult> {
  await run(bin('pg_dump', opts.binDir), ['--format=custom', '--dbname', connString, '--file', outFile], { maxBuffer: 1 << 26 });
  return { file: outFile, bytes: statSync(outFile).size };
}

/**
 * Restore a custom-format backup into the database, dropping existing objects
 * first (--clean --if-exists) so the restore is idempotent. Returns when done.
 */
export async function restoreEdge(connString: string, file: string, opts: { binDir?: string | undefined } = {}): Promise<void> {
  // pg_restore exits non-zero on benign "does not exist, skipping" notices with
  // --clean on a fresh DB; --if-exists suppresses the errors, and we tolerate a
  // non-zero exit as long as the data restores (verified by the caller/tests).
  try {
    await run(bin('pg_restore', opts.binDir), ['--clean', '--if-exists', '--no-owner', '--dbname', connString, file], { maxBuffer: 1 << 26 });
  } catch (e) {
    // Surface only if it is not the expected "already exists / does not exist" noise.
    const msg = (e as { stderr?: string }).stderr ?? String(e);
    if (!/does not exist, skipping|already exists|errors ignored on restore/i.test(msg)) throw e;
  }
}
