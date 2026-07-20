/**
 * Device trust and revocation (ADM-002, UAT-14). Registered devices may submit
 * changes; a revoked device is blocked from future sync. Trust state is checked
 * before the edge drains its outbox and (in the cloud) at sync ingress, so a lost
 * device cannot push once revoked. Uses the security_sync.device table.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class DeviceError extends Error {}

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
