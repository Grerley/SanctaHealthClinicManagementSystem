/**
 * Approved accounting-data export (FIN-014) against real PostgreSQL. Proves: the
 * export of a period's posted journal lines always balances (Σ debits = Σ credits)
 * and is idempotent — re-exporting an unchanged period yields the same
 * idempotencyKey; an unknown period is rejected.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { doCheckout } from '../src/api.ts';
import { exportApprovedLedger } from '../src/finance-reports.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
let PERIOD: string;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 1500, paymentMinor: 1500, paymentMethod: 'cash' });
  const r = await pool.query(`SELECT period_id FROM finance.journal_batch WHERE period_id IS NOT NULL LIMIT 1`);
  PERIOD = r.rows[0].period_id;
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('an approved-data export balances (FIN-014)', { skip }, async () => {
  const exp = await exportApprovedLedger(pool, { periodId: PERIOD, exportedBy: PATIENT });
  assert.equal(exp.balanced, true);
  assert.equal(exp.totalDebitMinor, exp.totalCreditMinor);
  assert.ok(exp.lineCount > 0);
  assert.ok(exp.lines.length === exp.lineCount);
  assert.ok(exp.idempotencyKey.length === 64); // sha-256 hex

  // The export is audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE action='export' AND resource_type='ledger_export'`);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('the export is idempotent — same period → same key (FIN-014)', { skip }, async () => {
  const a = await exportApprovedLedger(pool, { periodId: PERIOD });
  const b = await exportApprovedLedger(pool, { periodId: PERIOD });
  assert.equal(a.idempotencyKey, b.idempotencyKey); // deterministic over content, not wall-clock

  // A new posting changes the content → a different key.
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 800, paymentMinor: 800, paymentMethod: 'cash' });
  const c = await exportApprovedLedger(pool, { periodId: PERIOD });
  assert.notEqual(c.idempotencyKey, a.idempotencyKey);
});

test('an unknown period is rejected (FIN-014)', { skip }, async () => {
  await assert.rejects(exportApprovedLedger(pool, { periodId: '1999-01' }), /unknown financial period/);
});
