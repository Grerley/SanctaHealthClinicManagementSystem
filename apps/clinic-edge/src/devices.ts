/**
 * Device trust and revocation (ADM-002, UAT-14). Registered devices may submit
 * changes; a revoked device is blocked from future sync. Trust state is checked
 * before the edge drains its outbox and (in the cloud) at sync ingress, so a lost
 * device cannot push once revoked. Uses the security_sync.device table.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class DeviceError extends Error {}

export type DeviceRow = { deviceId: string; label: string; site: string | null; trustState: string; softwareVersion: string | null; registeredAt: string; revokedAt: string | null };

/** Every provisioned device with its trust state (ADM-002). A revoked device is
 * shown, not hidden, so an operator can audit what was decommissioned and when.
 * Trusted first, then most-recently registered. Read-only. */
export async function listDevices(pool: Pool): Promise<DeviceRow[]> {
  const r = await pool.query(
    `SELECT id, label, site_id, trust_state, software_version,
            to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS registered_at,
            to_char(revoked_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS revoked_at
       FROM security_sync.device
      ORDER BY (trust_state='trusted') DESC, created_at DESC`,
  );
  return r.rows.map((x) => ({
    deviceId: x.id, label: x.label, site: x.site_id, trustState: x.trust_state,
    softwareVersion: x.software_version, registeredAt: x.registered_at, revokedAt: x.revoked_at,
  }));
}

export async function registerDevice(pool: Pool, args: { label: string; site?: string; softwareVersion?: string }): Promise<{ deviceId: string }> {
  const deviceId = uuidv7();
  await pool.query(
    `INSERT INTO security_sync.device (id, label, site_id, trust_state, software_version) VALUES ($1,$2,$3,'trusted',$4)`,
    [deviceId, args.label, args.site ?? null, args.softwareVersion ?? null],
  );
  return { deviceId };
}

export async function revokeDevice(pool: Pool, args: { deviceId: string; user?: string }): Promise<void> {
  const r = await pool.query(`UPDATE security_sync.device SET trust_state='revoked', revoked_at=now() WHERE id=$1`, [args.deviceId]);
  if (r.rowCount === 0) throw new DeviceError('device not found');
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'amend','device',$3,'success','device revoked', now(), $4)`,
    [uuidv7(), args.user ?? null, args.deviceId, 'device-revoke:' + args.deviceId],
  );
}

export async function isDeviceTrusted(pool: Pool, deviceId: string): Promise<boolean> {
  const r = await pool.query(`SELECT trust_state FROM security_sync.device WHERE id=$1`, [deviceId]);
  if (r.rows.length === 0) return false;
  return r.rows[0].trust_state === 'trusted';
}

/** Throw if the device may not submit changes (revoked or unknown). */
export async function assertDeviceTrusted(pool: Pool, deviceId: string): Promise<void> {
  if (!(await isDeviceTrusted(pool, deviceId))) {
    throw new DeviceError('device is not trusted; sync is blocked until re-provisioned');
  }
}
