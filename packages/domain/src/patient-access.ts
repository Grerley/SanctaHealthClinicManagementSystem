/**
 * Access rules for restricted/sensitive patient records (PAT-009, pack §6.6).
 *
 * Records carry a sensitivity: normal, sensitive or restricted. Normal records
 * follow ordinary RBAC. Sensitive records may be accessed by clinical roles but
 * the access must carry a stated purpose (and is audited). Restricted records
 * require an explicitly authorised role OR a break-glass override with a reason —
 * emergency access is never blocked, but it is always accountable.
 */
import type { Role } from './rbac.ts';

export type Sensitivity = 'normal' | 'sensitive' | 'restricted';

/** Roles explicitly authorised to open restricted records without break-glass. */
export const RESTRICTED_ROLES: readonly Role[] = ['clinical', 'manager', 'administrator'];

export type AccessRequest = { roles: readonly Role[]; purpose?: string; breakGlass?: boolean; breakGlassReason?: string };
export type AccessDecision = { allowed: boolean; requiresAudit: boolean; breakGlass: boolean; reason?: string };

export class PatientAccessError extends Error {}

/**
 * Decide whether a caller may access a record of the given sensitivity. Sensitive
 * access needs a purpose; restricted access needs an authorised role or a
 * break-glass override with a reason.
 */
export function patientAccessDecision(sensitivity: Sensitivity, req: AccessRequest): AccessDecision {
  if (sensitivity === 'normal') return { allowed: true, requiresAudit: false, breakGlass: false };

  if (sensitivity === 'sensitive') {
    if (!req.purpose?.trim()) return { allowed: false, requiresAudit: false, breakGlass: false, reason: 'a stated purpose is required to open a sensitive record' };
    return { allowed: true, requiresAudit: true, breakGlass: false };
  }

  // restricted
  const authorised = req.roles.some((r) => RESTRICTED_ROLES.includes(r));
  if (authorised) {
    if (!req.purpose?.trim()) return { allowed: false, requiresAudit: false, breakGlass: false, reason: 'a stated purpose is required to open a restricted record' };
    return { allowed: true, requiresAudit: true, breakGlass: false };
  }
  if (req.breakGlass) {
    if (!req.breakGlassReason?.trim()) return { allowed: false, requiresAudit: false, breakGlass: true, reason: 'break-glass access requires a reason' };
    return { allowed: true, requiresAudit: true, breakGlass: true };
  }
  return { allowed: false, requiresAudit: false, breakGlass: false, reason: 'restricted record: an authorised role or break-glass override is required' };
}

/** Throwing variant for the access choke point. */
export function assertPatientAccess(sensitivity: Sensitivity, req: AccessRequest): AccessDecision {
  const d = patientAccessDecision(sensitivity, req);
  if (!d.allowed) throw new PatientAccessError(d.reason ?? 'access denied');
  return d;
}
