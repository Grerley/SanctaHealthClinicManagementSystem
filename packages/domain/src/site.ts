/**
 * Multi-site access scoping (OPS-008, pack §11.4). A clinic network runs local
 * operations per site with central oversight. Central roles (manager, administrator,
 * auditor) may see across every site; everyone else is scoped to their own site.
 * This is the pure authorisation matrix; the edge applies it when listing or
 * acting on site-scoped data.
 */
import type { Role } from './rbac.ts';

/** Roles granted network-wide (central oversight) visibility. */
export const CENTRAL_ROLES: readonly Role[] = ['manager', 'administrator', 'auditor'];

export function isCentral(roles: readonly Role[]): boolean {
  return roles.some((r) => CENTRAL_ROLES.includes(r));
}

/** May a user with these roles at `userSiteId` access data belonging to `targetSiteId`? */
export function canAccessSite(roles: readonly Role[], userSiteId: string | null, targetSiteId: string | null): boolean {
  if (isCentral(roles)) return true; // central oversight sees all sites
  if (targetSiteId === null) return true; // unscoped (network) data is visible to any authenticated user
  if (userSiteId === null) return false; // a local user with no site sees no site-scoped data
  return userSiteId === targetSiteId; // local operations: own site only
}

/** The set of sites a user may see, given all sites in the network. */
export function accessibleSites(roles: readonly Role[], userSiteId: string | null, allSiteIds: readonly string[]): string[] {
  if (isCentral(roles)) return [...allSiteIds];
  return userSiteId && allSiteIds.includes(userSiteId) ? [userSiteId] : [];
}
