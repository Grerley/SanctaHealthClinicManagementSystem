/**
 * Device trust and revocation on D1 (ADM-002, UAT-14). Registered devices may
 * submit changes; a revoked device is blocked. Trust state is checked before a
 * device's changes are accepted, so a lost device cannot push once revoked.
 * Ported from the Postgres edge `devices.ts`.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

export class DeviceError extends Error {}

export type DeviceRow = { deviceId: string; label: string; site: string | null; trustState: string; softwareVersion: string | null; registeredAt: string; revokedAt: string | null };

/** Every provisioned device with its trust state (ADM-002 device register). A
 * revoked device is shown, not hidden, so an operator can see what was decommissioned
 * and when — trusted devices first, then most-recently registered. Read-only. */
export async function listDevices(db: D1Database): Promise<DeviceRow[]> {
  const rows = await many<{ id: string; label: string; site_id: string | null; trust_state: string; software_version: string | null; created_at: string; revoked_at: string | null }>(
    db,
    `SELECT id, label, site_id, trust_state, software_version, created_at, revoked_at
       FROM security_sync_device
      ORDER BY (trust_state='trusted') DESC, created_at DESC`,
  );
  return rows.map((r) => ({
    deviceId: r.id, label: r.label, site: r.site_id, trustState: r.trust_state,
    softwareVersion: r.software_version, registeredAt: r.created_at, revokedAt: r.revoked_at,
  }));
}

export async function registerDevice(db: D1Database, args: { label: string; site?: string; softwareVersion?: string }): Promise<{ deviceId: string }> {
  const deviceId = uuidv7();
  await db.prepare(`INSERT INTO security_sync_device (id, label, site_id, trust_state, software_version) VALUES (?,?,?,'trusted',?)`)
    .bind(deviceId, args.label, args.site ?? null, args.softwareVersion ?? null).run();
  return { deviceId };
}

export async function revokeDevice(db: D1Database, args: { deviceId: string; user?: string }): Promise<void> {
  const changed = await run(db, `UPDATE security_sync_device SET trust_state='revoked', revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, [args.deviceId]);
  if (changed === 0) throw new DeviceError('device not found');
  await db.batch([
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','device',?,'success','device revoked',?)`,
      [uuidv7(), args.user ?? null, args.deviceId, 'device-revoke:' + args.deviceId]),
  ]);
}

export async function isDeviceTrusted(db: D1Database, deviceId: string): Promise<boolean> {
  const r = await one<{ trust_state: string }>(db, `SELECT trust_state FROM security_sync_device WHERE id=?`, [deviceId]);
  return !!r && r.trust_state === 'trusted';
}

/** Throw if the device may not submit changes (revoked or unknown). */
export async function assertDeviceTrusted(db: D1Database, deviceId: string): Promise<void> {
  if (!(await isDeviceTrusted(db, deviceId))) {
    throw new DeviceError('device is not trusted; sync is blocked until re-provisioned');
  }
}
