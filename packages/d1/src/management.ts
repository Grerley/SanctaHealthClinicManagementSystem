/**
 * Management command-centre extensions on D1 (MGT-002/006/007/010). The dashboard
 * itself is in ./dashboard.ts; this module adds the governance around it: exporting
 * a management pack (audited), resolving a requested site filter against the
 * caller's authorised scope, gating drill-through from a summary KPI to underlying
 * detail (a summary is never a back door), and an append-only manager commentary /
 * corrective-action log. Ported from the Postgres edge `management.ts`.
 */
import { uuidv7, effectiveSiteFilter, canDrill, drillPermission, type Role, type DrillTarget } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many, stmt } from './query.ts';
import { dashboard, type Dashboard } from './dashboard.ts';

export class ManagementScopeError extends Error {}

export type ManagementExport = {
  asOf: string;
  filters: Record<string, string>;
  confidentiality: string;
  exportedBy: string;
  format: string;
  dashboard: Dashboard;
};

/**
 * Export a management pack (MGT-007, UAT-15). The envelope carries the as-of time,
 * filters, owner and confidentiality label; the export itself is audited (bulk
 * export of aggregate data). Patient-level detail is not included here.
 */
export async function exportDashboard(
  db: D1Database,
  args: { asOf: string; exportedBy: string; filters?: Record<string, string>; format?: 'json' | 'csv' | 'pdf' },
): Promise<ManagementExport> {
  const dash = await dashboard(db, args.asOf);
  const envelope: ManagementExport = {
    asOf: args.asOf,
    filters: args.filters ?? {},
    confidentiality: 'management-only',
    exportedBy: args.exportedBy,
    format: args.format ?? 'json',
    dashboard: dash,
  };
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, outcome, reason, event_hash) VALUES (?,?,'export','management_report','success',?,?)`)
    .bind(uuidv7(), args.exportedBy, `management pack as-of ${args.asOf} (${envelope.format})`, 'mgmt-export:' + uuidv7()).run();
  return envelope;
}

/**
 * Resolve a requested site filter against the caller's authorised scope (MGT-002).
 * Central roles may narrow to any site; a local user is silently constrained to
 * their own — requested sites outside scope are reported as `rejected`, never
 * returned. With no request, all accessible sites are returned.
 */
export async function resolveSiteScope(
  db: D1Database,
  args: { roles: readonly Role[]; userSite: string | null; requestedSites?: readonly string[] },
): Promise<{ allowed: string[]; rejected: string[] }> {
  const rows = await many<{ id: string }>(db, `SELECT id FROM organisation_site WHERE active=1`);
  const allSites = rows.map((x) => x.id);
  return effectiveSiteFilter(args.roles, args.userSite, args.requestedSites ?? [], allSites);
}

/**
 * Gate a drill-through from a summary KPI to underlying detail (MGT-006). A summary
 * is never a back door: reaching patient/clinical detail requires the clinical-
 * detail permission regardless of dashboard access. Denials are audited.
 */
export async function drillThrough(
  db: D1Database,
  args: { roles: readonly Role[]; target: DrillTarget; actor?: string },
): Promise<{ target: DrillTarget; permission: string }> {
  const permission = drillPermission(args.target);
  if (!canDrill(args.roles, args.target)) {
    await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, outcome, reason, event_hash) VALUES (?,?,'access','management_drill','deny',?,?)`)
      .bind(uuidv7(), args.actor ?? null, `drill to ${args.target} requires ${permission}`, 'mgmt-drill:' + uuidv7()).run();
    throw new ManagementScopeError(`drill-through to ${args.target} requires permission: ${permission}`);
  }
  return { target: args.target, permission };
}

export type Commentary = {
  id: string; kpiId: string; period: string; commentary: string; action: string | null;
  actionOwner: string | null; dueDate: string | null; status: string; authoredBy: string | null; authoredAt: string;
};

/**
 * Append a manager's commentary — and optional corrective action — for a KPI
 * period (MGT-010). Append-only: prior notes are never overwritten, so the record
 * of why a number moved and what was decided is preserved.
 */
export async function addCommentary(
  db: D1Database,
  args: { kpiId: string; period: string; commentary: string; action?: string; actionOwner?: string; dueDate?: string; authoredBy?: string },
): Promise<{ id: string }> {
  if (!args.kpiId?.trim() || !args.period?.trim()) throw new ManagementScopeError('a KPI id and period are required');
  if (!args.commentary?.trim()) throw new ManagementScopeError('commentary text is required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO organisation_kpi_commentary (id, kpi_id, period, commentary, action, action_owner, due_date, authored_by) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, args.kpiId, args.period, args.commentary, args.action ?? null, args.actionOwner ?? null, args.dueDate ?? null, args.authoredBy ?? null).run();
  return { id };
}

/** Commentary history for a KPI period, newest first (MGT-010). */
export async function listCommentary(db: D1Database, args: { kpiId: string; period: string }): Promise<Commentary[]> {
  const rows = await many<{ id: string; kpi_id: string; period: string; commentary: string; action: string | null; action_owner: string | null; due_date: string | null; status: string; authored_by: string | null; authored_at: string }>(db,
    `SELECT id, kpi_id, period, commentary, action, action_owner, due_date, status, authored_by, authored_at
     FROM organisation_kpi_commentary WHERE kpi_id=? AND period=? ORDER BY authored_at DESC`, [args.kpiId, args.period]);
  return rows.map((x) => ({
    id: x.id, kpiId: x.kpi_id, period: x.period, commentary: x.commentary, action: x.action,
    actionOwner: x.action_owner, dueDate: x.due_date, status: x.status, authoredBy: x.authored_by, authoredAt: x.authored_at,
  }));
}
