/**
 * Management dashboard scope & drill-through authorisation (MGT-002, MGT-006,
 * pack §9). Filters are constrained to the caller's authorised scope — a user can
 * only narrow to sites they may see (central roles see all). Drill-through from a
 * KPI to underlying detail is gated by the permission that detail requires, so a
 * summary never becomes a back door to patient or finance detail.
 */
import { type Role, type Permission, can } from './rbac.ts';
import { accessibleSites } from './site.ts';

/**
 * Resolve a requested site filter against the caller's scope (MGT-002). Returns
 * the sites they may see among those requested (or all accessible if none
 * requested), and any requested sites that were rejected as out of scope.
 */
export function effectiveSiteFilter(
  roles: readonly Role[],
  userSite: string | null,
  requestedSites: readonly string[],
  allSites: readonly string[],
): { allowed: string[]; rejected: string[] } {
  const accessible = new Set(accessibleSites(roles, userSite, allSites));
  if (requestedSites.length === 0) return { allowed: [...accessible], rejected: [] };
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const s of requestedSites) (accessible.has(s) ? allowed : rejected).push(s);
  return { allowed, rejected };
}

export type DrillTarget = 'operational' | 'clinical_detail' | 'patient_detail' | 'finance_detail';

/** The permission a drill-through target requires (MGT-006). */
export function drillPermission(target: DrillTarget): Permission {
  switch (target) {
    case 'clinical_detail':
    case 'patient_detail':
      return 'view_clinical_detail';
    case 'finance_detail':
      return 'view_summary';
    case 'operational':
    default:
      return 'view_summary';
  }
}

/** May these roles drill through to the target's detail (MGT-006)? */
export function canDrill(roles: readonly Role[], target: DrillTarget): boolean {
  return can(roles, drillPermission(target));
}
