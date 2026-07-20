/**
 * Multi-site registry + scoped listing (OPS-008). Sites are reference data;
 * visibility applies the domain authorisation matrix (`accessibleSites`) so local
 * users see their own site and central roles see the whole network.
 */
import type { Pool } from 'pg';
import { uuidv7, accessibleSites, type Role } from '@sancta/domain';

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
