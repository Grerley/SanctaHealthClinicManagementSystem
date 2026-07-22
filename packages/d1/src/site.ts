/**
 * Multi-site registry + scoped listing on D1 (OPS-008). Sites are reference data;
 * visibility applies the domain authorisation matrix (`accessibleSites`) so local
 * users see their own site and central roles see the whole network. Replication
 * planning (SYN-008) applies the domain rules to decide which patient records a
 * scoped node receives. Ported from the Postgres edge `site.ts`.
 *
 * D1 translations: boolean is_central/active → INTEGER 0/1; Postgres date
 * arithmetic → age in days computed in JS from stored ISO text.
 */
import { uuidv7, accessibleSites, planReplication, type Role, type ReplicationScope } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many, stmt } from './query.ts';

export class SiteError extends Error {}

export async function registerSite(db: D1Database, args: { code: string; name: string; isCentral?: boolean }): Promise<{ id: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new SiteError('site code and name are required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO organisation_site (id, code, name, is_central) VALUES (?,?,?,?)`).bind(id, args.code, args.name, args.isCentral ? 1 : 0).run();
  return { id };
}

export type SiteRow = { id: string; code: string | null; name: string; isCentral: boolean; active: boolean };

async function allSites(db: D1Database): Promise<SiteRow[]> {
  const rows = await many<{ id: string; code: string | null; name: string; is_central: number; active: number }>(db, `SELECT id, code, name, is_central, active FROM organisation_site ORDER BY code`);
  return rows.map((x) => ({ id: x.id, code: x.code, name: x.name, isCentral: Boolean(x.is_central), active: Boolean(x.active) }));
}

/**
 * Sites visible to a caller (OPS-008 authorisation matrix). Central roles see the
 * whole network; a local user sees only their own site.
 */
export async function listSitesForUser(db: D1Database, roles: Role[], userSiteId: string | null): Promise<SiteRow[]> {
  const sites = await allSites(db);
  const allowed = new Set(accessibleSites(roles, userSiteId, sites.map((s) => s.id)));
  return sites.filter((s) => allowed.has(s.id));
}

/**
 * Plan which patient records replicate to a node with the given scope (SYN-008).
 * Applies the domain replication rules (site, sensitivity ceiling, recency window)
 * to the local patients and returns counts — the transport uses the same decision
 * so a node never receives out-of-scope data.
 */
export async function replicationPlan(
  db: D1Database,
  args: { scope: ReplicationScope; asOf: string },
): Promise<{ replicated: number; withheld: number; sample: Array<{ patientId: string; siteId: string | null; sensitivity: string }> }> {
  const rows = await many<{ id: string; site_id: string | null; sensitivity: string; updated_at: string | null; created_at: string }>(db,
    `SELECT id, site_id, sensitivity, updated_at, created_at FROM identity_patient`);
  const asOfMs = new Date(args.asOf).getTime();
  const records = rows.map((x) => {
    const ref = x.updated_at ?? x.created_at;
    const ageDays = Math.max(0, Math.floor((asOfMs - new Date(ref).getTime()) / 86_400_000));
    return { patientId: x.id, siteId: x.site_id, sensitivity: x.sensitivity as 'normal' | 'sensitive' | 'restricted', ageDays };
  });
  const { replicated, withheld } = planReplication(records, args.scope);
  return {
    replicated: replicated.length,
    withheld: withheld.length,
    sample: replicated.slice(0, 10).map((x) => ({ patientId: x.patientId, siteId: x.siteId, sensitivity: x.sensitivity })),
  };
}
