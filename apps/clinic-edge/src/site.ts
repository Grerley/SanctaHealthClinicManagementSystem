/**
 * Multi-site registry + scoped listing (OPS-008). Sites are reference data;
 * visibility applies the domain authorisation matrix (`accessibleSites`) so local
 * users see their own site and central roles see the whole network.
 */
import type { Pool } from 'pg';
import { uuidv7, accessibleSites, planReplication, type Role, type ReplicationScope } from '@sancta/domain';

export class SiteError extends Error {}

export async function registerSite(pool: Pool, args: { code: string; name: string; isCentral?: boolean }): Promise<{ id: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new SiteError('site code and name are required');
  const id = uuidv7();
  await pool.query(`INSERT INTO organisation.site (id, code, name, is_central) VALUES ($1,$2,$3,$4)`, [id, args.code, args.name, args.isCentral ?? false]);
  return { id };
}

export type SiteRow = { id: string; code: string; name: string; isCentral: boolean; active: boolean };

async function allSites(pool: Pool): Promise<SiteRow[]> {
  const r = await pool.query(`SELECT id, code, name, is_central, active FROM organisation.site ORDER BY code`);
  return r.rows.map((x) => ({ id: x.id, code: x.code, name: x.name, isCentral: x.is_central, active: x.active }));
}

/**
 * Sites visible to a caller (OPS-008 authorisation matrix). Central roles see the
 * whole network; a local user sees only their own site.
 */
export async function listSitesForUser(pool: Pool, roles: Role[], userSiteId: string | null): Promise<SiteRow[]> {
  const sites = await allSites(pool);
  const allowed = new Set(accessibleSites(roles, userSiteId, sites.map((s) => s.id)));
  return sites.filter((s) => allowed.has(s.id));
}

/**
 * Plan which patient records replicate to a node with the given scope (SYN-008).
 * Applies the domain replication rules (site, sensitivity ceiling, recency window)
 * to the local patients and returns counts — the transport layer uses the same
 * decision when building a delta so a node never receives out-of-scope data.
 */
export async function replicationPlan(
  pool: Pool,
  args: { scope: ReplicationScope; asOf: string },
): Promise<{ replicated: number; withheld: number; sample: Array<{ patientId: string; siteId: string | null; sensitivity: string }> }> {
  const r = await pool.query(
    `SELECT id, site_id, sensitivity::text AS sensitivity,
            GREATEST(0, ($1::date - updated_at::date))::int AS age_days
     FROM identity.patient`,
    [args.asOf],
  );
  const records = r.rows.map((x) => ({ patientId: x.id, siteId: x.site_id as string | null, sensitivity: x.sensitivity as 'normal' | 'sensitive' | 'restricted', ageDays: Number(x.age_days) }));
  const { replicated, withheld } = planReplication(records, args.scope);
  return {
    replicated: replicated.length,
    withheld: withheld.length,
    sample: replicated.slice(0, 10).map((x) => ({ patientId: x.patientId, siteId: x.siteId, sensitivity: x.sensitivity })),
  };
}
