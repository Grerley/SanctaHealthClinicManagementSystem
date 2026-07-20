/**
 * Edge backup & restore (UAT-16) against real PostgreSQL. Proves: after a
 * catastrophic loss (schemas dropped), restoring from a verified backup brings back
 * the transaction, its journals, its audit trail and the stock movement — with the
 * ledgers still balancing.
 *
 * Skips unless DATABASE_URL is set. PG_BIN_DIR points at pg_dump/pg_restore.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { doCheckout } from '../src/api.ts';
import { backupEdge, restoreEdge } from '../src/backup.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const BIN_DIR = process.env['PG_BIN_DIR'];
// Needs the pg_dump/pg_restore client tools; gated on PG_BIN_DIR so the general
// integration run skips it cleanly where they are not installed.
const skip = !DATABASE_URL || !BIN_DIR;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const backupFile = join(tmpdir(), 'sancta-edge-backup.dump');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
let invoiceId = '';

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(allMigrationsSql());
    await c.query(readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8'));
  } finally {
    c.release();
  }
  const out = await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 4, chargeMinor: 400, paymentMinor: 400, paymentMethod: 'cash' });
  if (out.ok) invoiceId = out.invoiceId;
});
after(async () => {
  if (skip) return;
  await pool.end();
  try { rmSync(backupFile); } catch { /* ignore */ }
});

async function counts(): Promise<{ invoices: number; movements: number; audit: number; tbNet: number }> {
  const inv = await pool.query(`SELECT count(*)::int AS n FROM billing.invoice`);
  const mv = await pool.query(`SELECT count(*)::int AS n FROM inventory.stock_movement WHERE movement_type='dispense'`);
  const au = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='dispense'`);
  const tb = await pool.query(`SELECT coalesce(sum(debit_minor)-sum(credit_minor),0)::int AS n FROM finance.journal_line`);
  return { invoices: inv.rows[0].n, movements: mv.rows[0].n, audit: au.rows[0].n, tbNet: tb.rows[0].n };
}

test('backup then restore after catastrophic loss recovers all data with balanced ledgers (UAT-16)', { skip }, async () => {
  const before = await counts();
  assert.ok(before.invoices >= 1);

  // Take a verified backup.
  const backup = await backupEdge(DATABASE_URL as string, backupFile, { binDir: BIN_DIR });
  assert.ok(backup.bytes > 0, 'backup file has content');

  // Simulate catastrophic loss.
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
  } finally {
    c.release();
  }
  const gone = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='billing'`);
  assert.equal(gone.rows[0].n, 0, 'schemas are gone after loss');

  // Restore from the backup.
  await restoreEdge(DATABASE_URL as string, backupFile, { binDir: BIN_DIR });

  const after = await counts();
  assert.equal(after.invoices, before.invoices, 'invoices restored');
  assert.equal(after.movements, before.movements, 'stock movements restored');
  assert.equal(after.audit, before.audit, 'audit trail restored');
  assert.equal(after.tbNet, 0, 'trial balance still nets to zero after restore');

  // The specific invoice is back.
  const inv = await pool.query(`SELECT count(*)::int AS n FROM billing.invoice WHERE id=$1`, [invoiceId]);
  assert.equal(inv.rows[0].n, 1);
});
