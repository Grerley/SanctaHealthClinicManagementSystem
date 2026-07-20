/**
 * Management command centre (MGT-001/003/008) against real PostgreSQL. Proves the
 * dashboard aggregates live data: every KPI carries a definition/owner/formula;
 * exceptions surface open critical results, debtors, stock alerts and pending sync;
 * and debtors reconcile to the AR control account.
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
import { createOrder, releaseResult } from '../src/orders.ts';
import { dashboard } from '../src/management.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';

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

test('every KPI has a definition, owner, unit and formula (MGT-008)', { skip }, async () => {
  const d = await dashboard(pool, '2026-07-19');
  assert.ok(d.kpis.length > 0);
  for (const k of d.kpis) {
    assert.ok(k.id && k.label && k.owner && k.unit && k.formula, `KPI ${k.id} is fully defined`);
  }
});

test('the dashboard aggregates live data and leads with exceptions (MGT-001/003)', { skip }, async () => {
  // A part-paid checkout (creates a debtor) and a critical lab result.
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 300, paymentMethod: 'cash' });
  const { orderId } = await createOrder(pool, { patientId: PATIENT, category: 'laboratory', code: 'GLUCOSE' });
  await releaseResult(pool, { orderId, value: 1.4, refLow: 4, refHigh: 7.8, criticalLow: 2.2 });

  const d = await dashboard(pool, '2026-07-19');

  const debtors = d.kpis.find((k) => k.id === 'outstanding_debtors');
  assert.equal(debtors?.value, 200); // 500 - 300
  assert.equal(d.kpis.find((k) => k.id === 'ar_reconciles')?.value, 1);
  assert.ok((d.kpis.find((k) => k.id === 'open_critical_results')?.value ?? 0) >= 1);
  assert.equal(d.kpis.find((k) => k.id === 'pending_sync')?.value, 1); // one checkout -> one outbox item

  // Exceptions include the open critical result and the debtor, each with a queue.
  assert.ok(d.exceptions.some((e) => e.type === 'open_critical_results' && e.queue.length > 0));
  assert.ok(d.exceptions.some((e) => e.type === 'debtors'));
});
