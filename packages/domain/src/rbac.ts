/**
 * Role-based access control (ADM-001, pack §5.1). Deny-by-default permission
 * verbs mapped to role families, plus maker-checker segregation (BR-011). No role
 * inherits clinical access merely because it can administer the system. This is
 * the baseline; attribute-based rules (site, patient relationship, purpose,
 * sensitivity, device trust, time) layer on top in the trusted enforcement layer.
 */

export type Permission =
  | 'discover'
  | 'view_summary'
  | 'view_clinical_detail'
  | 'create'
  | 'amend'
  | 'sign'
  | 'approve'
  | 'dispense'
  | 'bill'
  | 'receive_payment'
  | 'reverse'
  | 'export'
  | 'configure'
  | 'administer';

export type Role = 'reception' | 'clinical' | 'cashier' | 'stock' | 'finance' | 'manager' | 'administrator' | 'auditor';

const MATRIX: Readonly<Record<Role, readonly Permission[]>> = {
  reception: ['discover', 'view_summary', 'create', 'amend'],
  clinical: ['discover', 'view_summary', 'view_clinical_detail', 'create', 'amend', 'sign', 'dispense'],
  cashier: ['discover', 'view_summary', 'bill', 'receive_payment', 'reverse', 'export'],
  stock: ['discover', 'view_summary', 'dispense', 'create'],
  finance: ['view_summary', 'approve', 'reverse', 'configure', 'export'],
  manager: ['view_summary', 'export'],
  administrator: ['configure', 'administer'],
  auditor: ['discover', 'view_summary', 'export'],
};

export class AuthorisationError extends Error {}

/** Deny-by-default: true only if one of the roles grants the permission. */
export function can(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((r) => (MATRIX[r] ?? []).includes(permission));
}

export function assertCan(roles: readonly Role[], permission: Permission): void {
  if (!can(roles, permission)) {
    throw new AuthorisationError(`permission denied: ${permission}`);
  }
}

/** Administrators do not get clinical detail merely by being administrators (pack §5.1). */
export function canViewClinicalDetail(roles: readonly Role[]): boolean {
  return can(roles, 'view_clinical_detail');
}

/**
 * Maker-checker: a user cannot approve/authorise their own high-risk transaction
 * (BR-011). Returns false when the approver is the maker.
 */
export function canApprove(approverId: string, makerId: string): boolean {
  return approverId !== makerId;
}

export function assertSegregation(approverId: string, makerId: string): void {
  if (!canApprove(approverId, makerId)) {
    throw new AuthorisationError('segregation of duties: cannot approve your own transaction');
  }
}
