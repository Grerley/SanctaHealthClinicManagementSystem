/**
 * Device trust + revocation (ADM-002, UAT-14) against real PostgreSQL. Proves: a
 * registered device is trusted and can push; a revoked device is untrusted and its
 * sync push is blocked; revocation is audited.
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
import { registerDevice, revokeDevice, isDeviceTrusted, DeviceError } from '../src/devices.ts';
import { doCheckout, syncPush } from '../src/api.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const SITE = '00000000-0000-7000-8000-0000000000f1';

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

test('a registered device is trusted; a revoked device is not (ADM-002)', { skip }, async () => {
  const { deviceId } = await registerDevice(pool, { label: 'Reception tablet' });
  assert.equal(await isDeviceTrusted(pool, deviceId), true);
  await revokeDevice(pool, { deviceId });
  assert.equal(await isDeviceTrusted(pool, deviceId), false);

  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='device' AND resource_id=$1`, [deviceId]);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('a revoked device is blocked from pushing sync (UAT-14)', { skip }, async () => {
  const { deviceId } = await registerDevice(pool, { label: 'Lost tablet' });
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 2, chargeMinor: 200, paymentMinor: 0, paymentMethod: 'cash' });

  // Trusted device may push (points at a dead cloud so it just fails transport, not trust).
  await revokeDevice(pool, { deviceId });
  await assert.rejects(
    syncPush(pool, 'http://127.0.0.1:1/sync/ingress', SITE, 'token', deviceId),
    DeviceError,
  );
});

test('an unknown device is not trusted', { skip }, async () => {
  assert.equal(await isDeviceTrusted(pool, '00000000-0000-7000-8000-0000000000ff'), false);
  await assert.rejects(revokeDevice(pool, { deviceId: '00000000-0000-7000-8000-0000000000ff' }), DeviceError);
});
