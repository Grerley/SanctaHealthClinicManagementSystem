/**
 * Offline-resilience suite (pack §22 offline layer; NFR-001/002/010/031; UAT-11).
 * Runs against real edge + cloud PostgreSQL. Proves the clinic keeps working
 * through an internet outage and abrupt power loss, and reconciles on reconnect
 * with no lost or duplicated transactions.
 *
 * Skips unless DATABASE_URL and CLOUD_DATABASE_URL are set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { startCloudAdapter, stopCloudAdapter, type CloudAdapter } from '@sancta/cloud-worker/node-adapter';
import { doCheckout, syncStatus, syncPush } from '../src/api.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const CLOUD_DATABASE_URL = process.env['CLOUD_DATABASE_URL'];
const skip = !DATABASE_URL || !CLOUD_DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = readFileSync(join(repoRoot, 'packages/db/migrations/0001_init.sql'), 'utf8');
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
let cloud: CloudAdapter;
const SITE = '00000000-0000-7000-8000-0000000000f1';
const PATIENT = '00000000-0000-7000-8000-000000000101';
const DEAD_URL = 'http://127.0.0.1:1/sync/ingress'; // unreachable -> "internet down"

async function resetEdge(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
}

/** Clear cloud rows without dropping the schema the running adapter created. */
async function clearCloud(): Promise<void> {
  await cloud.pool.query(`DELETE FROM cloud.synced_checkout`);
  await cloud.pool.query(`DELETE FROM cloud.applied_change`);
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await resetEdge();
  // Fresh cloud store before the adapter starts.
  const cc = new pg.Client({ connectionString: CLOUD_DATABASE_URL });
  await cc.connect();
  await cc.query(`DROP SCHEMA IF EXISTS cloud CASCADE;`);
  await cc.end();
  cloud = await startCloudAdapter(CLOUD_DATABASE_URL as string);
});

after(async () => {
  if (skip) return;
  await pool.end();
  await stopCloudAdapter(cloud);
});

async function stockOf(sku: string): Promise<number> {
  const r = await pool.query(`SELECT coalesce(sum(on_hand),0)::int AS n FROM inventory.stock_balance WHERE sku=$1`, [sku]);
  return r.rows[0].n as number;
}
async function count(sql: string): Promise<number> {
  const r = await pool.query(sql);
  return r.rows[0].n as number;
}
async function cloudCount(): Promise<number> {
  const r = await cloud.pool.query(`SELECT count(*)::int AS n FROM cloud.synced_checkout`);
  return r.rows[0].n as number;
}

test('abrupt power loss mid-transaction leaves no partial data; DB recovers with no manual repair (NFR-031/002)', { skip }, async () => {
  const stockBefore = await stockOf('AMOX-500');

  // Simulate a power cut in the middle of a write: open a transaction, insert a
  // dispense movement, then destroy the socket before COMMIT.
  const victim = new pg.Client({ connectionString: DATABASE_URL });
  victim.on('error', () => {}); // swallow the socket-destroy error (simulated power loss)
  await victim.connect();
  await victim.query('BEGIN');
  await victim.query(
    `INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref)
     VALUES ('00000000-0000-7000-8000-00000000dead','AMOX-500','00000000-0000-7000-8000-000000000a01','MAIN','dispense',-50,'power-loss')`,
  );
  // Abrupt loss: destroy the underlying socket without COMMIT.
  (victim as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
  await new Promise((r) => setTimeout(r, 100));

  // A fresh connection sees a clean, consistent database — the uncommitted
  // movement never existed, and no manual recovery was needed.
  const stockAfter = await stockOf('AMOX-500');
  assert.equal(stockAfter, stockBefore, 'uncommitted dispense must not affect stock');
  assert.equal(await count(`SELECT count(*)::int AS n FROM inventory.stock_movement WHERE source_ref='power-loss'`), 0);

  // And normal work continues immediately.
  const ok = await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 500, paymentMinor: 500, paymentMethod: 'cash' });
  assert.ok(ok.ok);
  assert.equal(await stockOf('AMOX-500'), stockBefore - 10);
});

test('extended internet outage: many local commits, then bulk reconnect reconciles with no loss or duplication (NFR-001/010, UAT-11)', { skip }, async () => {
  await resetEdge(); await clearCloud();
  const N = 24; // stand-in for ~72h of intermittent walk-ins
  const stock0 = await stockOf('AMOX-500');

  // Internet is down for the whole outage: every checkout still commits locally.
  for (let i = 0; i < N; i++) {
    const out = await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 250, paymentMinor: 100, paymentMethod: 'cash' });
    assert.ok(out.ok, `checkout ${i} should commit locally offline`);
    // Attempting to sync during the outage fails but never blocks or loses work.
    if (i % 8 === 0) {
      const r = await syncPush(pool, DEAD_URL, SITE);
      assert.ok(r.failed >= 0);
    }
  }

  // All work is durably local: stock, invoices and balanced journals all present.
  assert.equal(await stockOf('AMOX-500'), stock0 - N * 5);
  assert.equal(await count(`SELECT count(*)::int AS n FROM billing.invoice`), N);
  assert.equal(await count(`SELECT count(*)::int AS n FROM finance.journal_batch`), N * 3);
  const tb = await pool.query(`SELECT sum(debit_minor)::bigint AS d, sum(credit_minor)::bigint AS c FROM finance.journal_line`);
  assert.equal(tb.rows[0].d, tb.rows[0].c); // trial balance still nets to zero
  assert.equal((await syncStatus(pool)).pending, N);
  assert.equal(await cloudCount(), 0);

  // Reconnect: one drain clears the whole backlog in batches.
  const r = await syncPush(pool, cloud.url, SITE);
  assert.equal(r.acknowledged, N);
  assert.equal((await syncStatus(pool)).pending, 0);
  assert.equal(await cloudCount(), N);

  // Repeated acknowledgement / duplicate delivery creates nothing new (NFR-010).
  const again = await syncPush(pool, cloud.url, SITE);
  assert.equal(again.attempted, 0);
  assert.equal(await cloudCount(), N);
});

test('concurrent dispensing during the outage keeps every movement (append-only, BR-007)', { skip }, async () => {
  await resetEdge(); await clearCloud();
  const stock0 = await stockOf('AMOX-500');
  // Fire several checkouts concurrently (separate pooled connections).
  const results = await Promise.all(
    Array.from({ length: 6 }, () => doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 3, chargeMinor: 150, paymentMinor: 0, paymentMethod: 'cash' })),
  );
  assert.ok(results.every((r) => r.ok));
  // No movement lost: balance reflects all six decrements.
  assert.equal(await stockOf('AMOX-500'), stock0 - 6 * 3);
  assert.equal((await syncStatus(pool)).pending, 6);
});
