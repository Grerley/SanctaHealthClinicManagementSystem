/**
 * End-to-end edge → cloud synchronisation over HTTP against two real PostgreSQL
 * databases (edge + canonical cloud). Proves the transport (item 2) and the
 * reconcile: a local checkout is committed offline, queued in the outbox, then
 * pushed to the cloud where it is durably applied; the cloud store reconciles to
 * the edge; and replay / cloud-down never duplicate a transaction (SYN-004/006,
 * CLD-003/004, NFR-010/038).
 *
 * Skips unless DATABASE_URL and CLOUD_DATABASE_URL are set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { startCloudAdapter, stopCloudAdapter, type CloudAdapter } from '@sancta/cloud-worker/node-adapter';
import { doCheckout, syncStatus, syncPush } from '../src/api.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const CLOUD_DATABASE_URL = process.env['CLOUD_DATABASE_URL'];
const skip = !DATABASE_URL || !CLOUD_DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let edgePool: pg.Pool;
let cloud: CloudAdapter;
const SITE = '00000000-0000-7000-8000-0000000000f1';
const PATIENT = '00000000-0000-7000-8000-000000000101';

before(async () => {
  if (skip) return;
  edgePool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await edgePool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
  // Fresh cloud store.
  const cc = new pg.Client({ connectionString: CLOUD_DATABASE_URL });
  await cc.connect();
  await cc.query(`DROP SCHEMA IF EXISTS cloud CASCADE;`);
  await cc.end();
  cloud = await startCloudAdapter(CLOUD_DATABASE_URL as string);
});

after(async () => {
  if (skip) return;
  await edgePool.end();
  await stopCloudAdapter(cloud);
});

async function cloudCount(): Promise<number> {
  const res = await cloud.pool.query(`SELECT count(*)::int AS n FROM cloud.synced_checkout`);
  return res.rows[0].n as number;
}

test('local checkout queues an outbox item while cloud is untouched', { skip }, async () => {
  const out = await doCheckout(edgePool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 500, paymentMinor: 300, paymentMethod: 'cash' });
  assert.ok(out.ok);
  assert.equal((await syncStatus(edgePool)).pending, 1);
  assert.equal(await cloudCount(), 0, 'nothing in the cloud until we push');
});

test('push synchronises the item to the cloud and reconciles (SYN-004)', { skip }, async () => {
  const r = await syncPush(edgePool, cloud.url, SITE);
  assert.equal(r.acknowledged, 1);
  assert.equal((await syncStatus(edgePool)).pending, 0);
  assert.equal(await cloudCount(), 1, 'cloud now holds the synced checkout');
});

test('re-push is idempotent — no duplicate in the cloud (NFR-010)', { skip }, async () => {
  const before = await cloudCount();
  const r = await syncPush(edgePool, cloud.url, SITE); // nothing queued now
  assert.equal(r.attempted, 0);
  assert.equal(await cloudCount(), before);
});

test('cloud unreachable: item stays queued, nothing lost (NFR-038)', { skip }, async () => {
  await doCheckout(edgePool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 5, chargeMinor: 250, paymentMinor: 0, paymentMethod: 'cash' });
  assert.equal((await syncStatus(edgePool)).pending, 1);
  // Point at a dead port -> transport fails.
  const r = await syncPush(edgePool, 'http://127.0.0.1:1/sync/ingress', SITE);
  assert.equal(r.failed, 1);
  assert.equal((await syncStatus(edgePool)).pending, 1, 'still queued after a failed push');
  // Recover: push to the real cloud drains it.
  const r2 = await syncPush(edgePool, cloud.url, SITE);
  assert.equal(r2.acknowledged, 1);
  assert.equal((await syncStatus(edgePool)).pending, 0);
  assert.equal(await cloudCount(), 2);
});
