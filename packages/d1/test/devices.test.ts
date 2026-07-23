/**
 * Device trust & revocation on D1 (ADM-002). Runs on real SQLite. Proves: a
 * registered device is trusted; a revoked device is blocked and asserting trust
 * throws; and an unknown device is untrusted.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerDevice, revokeDevice, isDeviceTrusted, assertDeviceTrusted, listDevices, DeviceError } from '../src/devices.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('a registered device is trusted until revoked', async () => {
  const { deviceId } = await registerDevice(db, { label: 'Reception tablet', softwareVersion: '1.0.0' });
  assert.equal(await isDeviceTrusted(db, deviceId), true);
  await assertDeviceTrusted(db, deviceId); // does not throw
  await revokeDevice(db, { deviceId, user: 'admin1' });
  assert.equal(await isDeviceTrusted(db, deviceId), false);
  await assert.rejects(() => assertDeviceTrusted(db, deviceId), DeviceError);
});

test('listDevices returns every device with trust state, trusted first, revoked shown not hidden', async () => {
  const { deviceId: a } = await registerDevice(db, { label: 'Reception tablet', softwareVersion: '1.0.0' });
  const { deviceId: b } = await registerDevice(db, { label: 'Pharmacy laptop' });
  await revokeDevice(db, { deviceId: a, user: 'admin1' });

  const devices = await listDevices(db);
  assert.equal(devices.length, 2);
  // The still-trusted device sorts ahead of the revoked one.
  assert.equal(devices[0]!.deviceId, b);
  assert.equal(devices[0]!.trustState, 'trusted');
  const revoked = devices.find((d) => d.deviceId === a)!;
  assert.equal(revoked.trustState, 'revoked');
  assert.equal(revoked.label, 'Reception tablet');
  assert.ok(revoked.revokedAt, 'a revoked device carries its revocation time');
});

test('an unknown device is untrusted and cannot be revoked', async () => {
  assert.equal(await isDeviceTrusted(db, 'ghost'), false);
  await assert.rejects(() => revokeDevice(db, { deviceId: 'ghost' }), DeviceError);
});
