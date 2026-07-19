/**
 * Payment allocation & reallocation (BIL-006, BR-006, UAT-08) against real
 * PostgreSQL. Proves: one payment allocates across invoices; reallocation moves
 * value without editing history (compensating entries); over-allocation is
 * refused; and invoice outstanding tracks the net allocation.
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
import { recordPayment, allocate, reallocate, invoiceOutstanding, BillingError } from '../src/billing.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';

let invA = '';
let invB = '';

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
  // Two unpaid invoices (charge only, no payment at checkout).
  const a = await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 500, paymentMinor: 0, paymentMethod: 'cash' });
  const b = await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 3, chargeMinor: 300, paymentMinor: 0, paymentMethod: 'cash' });
  if (a.ok) invA = a.invoiceId;
  if (b.ok) invB = b.invoiceId;
});
after(async () => {
  if (!skip && pool) await pool.end();
});

async function allocRowCount(paymentId: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM billing.payment_allocation WHERE payment_id=$1`, [paymentId]);
  return r.rows[0].n as number;
}

test('one payment allocates across two invoices, then reallocates preserving history (UAT-08)', { skip }, async () => {
  const { paymentId } = await recordPayment(pool, { patientId: PATIENT, method: 'cash', amountMinor: 500 });
  // Allocate all 500 to invoice A.
  await allocate(pool, { paymentId, allocations: [{ invoiceId: invA, amountMinor: 500 }] });
  assert.equal(await invoiceOutstanding(pool, invA), 0); // 500 - 500
  assert.equal(await invoiceOutstanding(pool, invB), 300); // untouched

  // Reallocate 200 from A to B — append-only.
  await reallocate(pool, { paymentId, fromInvoiceId: invA, toInvoiceId: invB, amountMinor: 200 });
  assert.equal(await invoiceOutstanding(pool, invA), 200); // 500 - 300 net
  assert.equal(await invoiceOutstanding(pool, invB), 100); // 300 - 200 net

  // History preserved: 3 allocation rows (initial +500, then -200 and +200).
  assert.equal(await allocRowCount(paymentId), 3);
});

test('over-allocation beyond the payment is refused (BIL-006)', { skip }, async () => {
  const { paymentId } = await recordPayment(pool, { patientId: PATIENT, method: 'cash', amountMinor: 100 });
  await assert.rejects(allocate(pool, { paymentId, allocations: [{ invoiceId: invA, amountMinor: 150 }] }), BillingError);
});

test('cannot reallocate more than is on the source invoice', { skip }, async () => {
  const { paymentId } = await recordPayment(pool, { patientId: PATIENT, method: 'cash', amountMinor: 100 });
  await allocate(pool, { paymentId, allocations: [{ invoiceId: invA, amountMinor: 100 }] });
  await assert.rejects(reallocate(pool, { paymentId, fromInvoiceId: invA, toInvoiceId: invB, amountMinor: 500 }), BillingError);
});
