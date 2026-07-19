/**
 * Financial period close/reopen control (FIN-009, BR-010, UAT-13) against real
 * PostgreSQL. Proves: posting works while a period is open; hard-closing rejects
 * further posting into that period (the whole checkout rolls back); reopening with
 * authority allows posting again; closing/reopening requires an approver.
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
import { closePeriod, reopenPeriod, periodStatus, PeriodClosedError, FinanceError } from '../src/finance.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const APPROVER = '00000000-0000-7000-8000-0000000000aa';

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
});
after(async () => {
  if (!skip && pool) await pool.end();
});

async function journalCount(): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM finance.journal_batch`);
  return r.rows[0].n as number;
}

test('posting works while the period is open, then closing requires an approver', { skip }, async () => {
  const ok = await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 2, chargeMinor: 200, paymentMinor: 200, paymentMethod: 'cash' });
  assert.ok(ok.ok);
  await assert.rejects(closePeriod(pool, { periodId: '2026-07' }), FinanceError); // no approver
});

test('a hard-closed period rejects further posting and rolls the whole checkout back (BR-010, UAT-13)', { skip }, async () => {
  await closePeriod(pool, { periodId: '2026-07', approver: APPROVER });
  assert.equal(await periodStatus(pool, '2026-07'), 'hard_close');

  const before = await journalCount();
  await assert.rejects(
    doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 2, chargeMinor: 200, paymentMinor: 200, paymentMethod: 'cash' }),
    PeriodClosedError,
  );
  assert.equal(await journalCount(), before, 'no journals posted into the closed period');
  // The whole transaction rolled back: no new invoice either.
  const inv = await pool.query(`SELECT count(*)::int AS n FROM billing.invoice`);
  assert.equal(inv.rows[0].n, 1); // only the first checkout's invoice
});

test('reopening with authority allows posting again (FIN-009)', { skip }, async () => {
  await assert.rejects(reopenPeriod(pool, { periodId: '2026-07' }), FinanceError); // no approver
  await reopenPeriod(pool, { periodId: '2026-07', approver: APPROVER, reason: 'late adjustment approved' });
  assert.equal(await periodStatus(pool, '2026-07'), 'open');

  const ok = await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 2, chargeMinor: 200, paymentMinor: 200, paymentMethod: 'cash' });
  assert.ok(ok.ok, 'posting succeeds after reopen');
});
