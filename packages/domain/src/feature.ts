/**
 * Feature-flag evaluation for staged rollout (ADM-006, pack §16). A flag is on for
 * a request when it is enabled AND (no site restriction or the site is listed) AND
 * (no role restriction or one of the caller's roles is listed). Empty restriction
 * lists mean "all". Pure and deterministic so rollout is predictable.
 */
import type { Role } from './rbac.ts';

export type FeatureFlag = {
  readonly key: string;
  readonly enabled: boolean;
  readonly sites: readonly string[]; // empty = all sites
  readonly roles: readonly string[]; // empty = all roles
};

export type FeatureContext = { site?: string | null; roles?: readonly Role[] };

export function featureEnabled(flag: FeatureFlag, ctx: FeatureContext = {}): boolean {
  if (!flag.enabled) return false;
  if (flag.sites.length > 0 && !(ctx.site && flag.sites.includes(ctx.site))) return false;
  if (flag.roles.length > 0 && !(ctx.roles ?? []).some((r) => flag.roles.includes(r))) return false;
  return true;
}
