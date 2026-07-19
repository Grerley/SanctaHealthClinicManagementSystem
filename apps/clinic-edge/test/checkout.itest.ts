/**
 * Vertical-slice integration test against REAL PostgreSQL (pack §22 integration
 * layer, UAT-01/UAT-10). Proves the atomic dispense-and-pay checkout: FEFO stock
 * decrement + finalised invoice + part-payment + balanced journals + audit +
 * outbox, all in one transaction; then that replay is idempotent (no duplicate
 * business transaction) and the ledgers reconcile.
 *
 * Skips automatically when DATABASE_URL is unset, so unit CI stays green without
 * a database. Run with:
 *   DATABASE_URL=postgres://sancta@127.0.0.1:5433/sancta_test npm run test:integration -w @sancta/clinic-edge
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { commitCheckout, DuplicateCheckoutError, type CheckoutRequest } from '../src/checkout.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = readFileSync(join(repoRoot, 'packages/db/migrations/0001_init.sql'), 'utf8');
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(
      `DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`,
    );
    await c.query(migration);
    await c.query(seed);
    // A signed encounter for the synthetic patient (slice precondition).
    await c.query(
      `INSERT INTO flow.visit (id, patient_id, visit_number, site_id, status)
       VALUES ('00000000-0000-7000-8000-000000000201','00000000-0000-7000-8000-000000000101','V-201','00000000-0000-7000-8000-0000000000f1','in_care')`,
    );
    await c.query(
      `INSERT INTO clinical.encounter (id, visit_id, patient_id, status, form_version, signed_by, signed_at)
       VALUES ('00000000-0000-7000-8000-000000000301','00000000-0000-7000-8000-000000000201','00000000-0000-7000-8000-000000000101','signed',1,'00000000-0000-7000-8000-0000000000e1', now())`,
    );
  } finally {
    c.release();
  }
});

after(async () => {
  if (!skip && pool) await pool.end();
});

function checkoutReq(): CheckoutRequest {
  return {
    dispense: {
      sku: 'AMOX-500',
      quantity: 60,
      patientId: '00000000-0000-7000-8000-000000000101',
      encounterId: '00000000-0000-7000-8000-000000000301',
      invoiceId: '00000000-0000-7000-8000-000000000401',
      chargeMinor: 1500,
      asOfDate: '2026-07-19',
      postingDate: '2026-07-19',
      location: 'MAIN',
      device: '00000000-0000-7000-8000-0000000000d1',
      user: '00000000-0000-7000-8000-0000000000e1',
      site: '00000000-0000-7000-8000-0000000000f1',
    },
    paymentMinor: 1000,
    paymentMethod: 'cash',
    now: 1_700_000_000_000,
  };
}

test('atomic checkout commits stock, invoice, payment and balanced journals (BR-008)', { skip }, async () => {
  const c = await pool.connect();
  try {
    const res = await commitCheckout(c, checkoutReq());
    // FEFO picks the earliest-expiry lot L2 (2026-08-01, @12) which has ample
    // stock in the seed, so all 60 units come from L2: 60 * 12 = 720.
    assert.equal(res.cogsMinor, 720);

    // Stock decremented: AMOX-500 was 1500, now 1440.
    const bal = await c.query(`SELECT sum(on_hand)::int AS total FROM inventory.stock_balance WHERE sku='AMOX-500'`);
    assert.equal(bal.rows[0].total, 1440);

    // Trial balance nets to zero across every journal line (FIN-002).
    const tb = await c.query(`SELECT sum(debit_minor)::int AS d, sum(credit_minor)::int AS c FROM finance.journal_line`);
    assert.equal(tb.rows[0].d, tb.rows[0].c);
    assert.equal(tb.rows[0].d, 1500 + 720 + 1000); // revenue + cogs + payment debits

    // Patient AR = invoice 1500 - payment 1000 = 500 outstanding (debtor).
    const ar = await c.query(
      `SELECT (sum(debit_minor)-sum(credit_minor))::int AS bal FROM finance.journal_line WHERE account_code='1200-PATIENT-AR'`,
    );
    assert.equal(ar.rows[0].bal, 500);

    // One outbox item + one audit event were written atomically.
    const ob = await c.query(`SELECT count(*)::int AS n FROM security_sync.outbox_item`);
    assert.equal(ob.rows[0].n, 1);
    const au = await c.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='dispense'`);
    assert.equal(au.rows[0].n, 1);
  } finally {
    c.release();
  }
});

test('replay is idempotent — no duplicate transaction (NFR-010)', { skip }, async () => {
  const c = await pool.connect();
  try {
    const before = await c.query(`SELECT count(*)::int AS n FROM inventory.stock_movement WHERE movement_type='dispense'`);
    await assert.rejects(commitCheckout(c, checkoutReq()), DuplicateCheckoutError);
    const after = await c.query(`SELECT count(*)::int AS n FROM inventory.stock_movement WHERE movement_type='dispense'`);
    assert.equal(after.rows[0].n, before.rows[0].n, 'replay must not add stock movements');

    // Journals unchanged too.
    const jb = await c.query(`SELECT count(*)::int AS n FROM finance.journal_batch`);
    assert.equal(jb.rows[0].n, 3);
  } finally {
    c.release();
  }
});

test('insufficient stock rolls back the whole checkout (all-or-nothing)', { skip }, async () => {
  const c = await pool.connect();
  try {
    const req = checkoutReq();
    const big = { ...req, dispense: { ...req.dispense, quantity: 99999, invoiceId: '00000000-0000-7000-8000-000000000402', encounterId: '00000000-0000-7000-8000-000000000399' } };
    await assert.rejects(commitCheckout(c, big), /insufficient/);
    // No invoice 402 was created — rollback proven.
    const inv = await c.query(`SELECT count(*)::int AS n FROM billing.invoice WHERE id='00000000-0000-7000-8000-000000000402'`);
    assert.equal(inv.rows[0].n, 0);
  } finally {
    c.release();
  }
});
