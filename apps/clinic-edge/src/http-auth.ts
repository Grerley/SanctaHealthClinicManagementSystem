/**
 * HTTP authorisation layer for the edge API (ADM-001). Deny-by-default: each
 * protected route declares the permission it needs, and the request's roles
 * (from the authenticated session — represented here by the `x-roles` header the
 * gateway/session populates) must grant it. This is the single choke point where
 * a real authenticated, device-bound session will inject the user + roles.
 */
import { type Role, type Permission, can } from '@sancta/domain';

const KNOWN_ROLES = new Set<Role>(['reception', 'clinical', 'cashier', 'stock', 'finance', 'manager', 'administrator', 'auditor']);

export type AuthContext = { user: string | null; roles: Role[] };

export function authFromHeaders(headers: Record<string, string | string[] | undefined>): AuthContext {
  const raw = headers['x-roles'];
  const list = (Array.isArray(raw) ? raw.join(',') : raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Role => KNOWN_ROLES.has(s as Role));
  const userRaw = headers['x-user'];
  const user = Array.isArray(userRaw) ? userRaw[0] ?? null : userRaw ?? null;
  return { user, roles: list };
}

type Rule = { method: string; test: RegExp; permission: Permission };

// Ordered rules; first match wins. Anything not matched is public (healthz, sync,
// static). Read endpoints require the least privilege (discover/view_summary).
const RULES: Rule[] = [
  // Identity
  { method: 'GET', test: /^\/api\/patients$/, permission: 'discover' },
  { method: 'POST', test: /^\/api\/patients$/, permission: 'create' },
  { method: 'GET', test: /^\/api\/patients\/policy$/, permission: 'view_summary' }, // PAT-004 capture policy
  { method: 'POST', test: /^\/api\/patients\/policy$/, permission: 'configure' },
  { method: 'GET', test: /^\/api\/patients\/history$/, permission: 'view_summary' }, // PAT-007 identity history
  { method: 'GET', test: /^\/api\/fhir\/Patient$/, permission: 'view_clinical_detail' }, // SYN-009 FHIR read (metadata is public)
  { method: 'POST', test: /^\/api\/patients\/(demographic|deceased)$/, permission: 'amend' },
  { method: 'POST', test: /^\/api\/patients\/(un)?merge$/, permission: 'administer' },
  // Sync conflict queue (SYN-006): identity edits and human resolution are privileged.
  { method: 'GET', test: /^\/api\/integrations\/(status|dead)$/, permission: 'view_summary' }, // SYN-010/CLD-003 queue
  { method: 'POST', test: /^\/api\/integrations\/replay$/, permission: 'administer' },
  { method: 'GET', test: /^\/api\/sync\/conflicts$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/sync\/demographic-update$/, permission: 'administer' },
  { method: 'POST', test: /^\/api\/sync\/conflicts\/resolve$/, permission: 'approve' },
  // Clinical
  { method: 'POST', test: /^\/api\/encounters\/(sign)$/, permission: 'sign' },
  { method: 'POST', test: /^\/api\/encounters\/(addendum|entered-in-error|draft)$/, permission: 'amend' },
  { method: 'POST', test: /^\/api\/encounters$/, permission: 'create' },
  { method: 'GET', test: /^\/api\/encounters\/get$/, permission: 'view_clinical_detail' },
  { method: 'POST', test: /^\/api\/encounters\/attach-form$/, permission: 'amend' },
  { method: 'GET', test: /^\/api\/patients\/timeline$/, permission: 'view_clinical_detail' }, // EHR-002
  { method: 'GET', test: /^\/api\/forms(\/get)?$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/forms$/, permission: 'configure' }, // EHR-003 form admin
  { method: 'POST', test: /^\/api\/triage\/vitals$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/allergies$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/prescribe$/, permission: 'sign' },
  { method: 'POST', test: /^\/api\/orders$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/orders\/(result|critical\/ack)$/, permission: 'amend' },
  { method: 'GET', test: /^\/api\/orders\/critical\/outstanding$/, permission: 'view_summary' },
  // Flow
  { method: 'POST', test: /^\/api\/visits\/(start|transfer|complete)$/, permission: 'create' },
  { method: 'GET', test: /^\/api\/visits\/queue$/, permission: 'discover' },
  // Billing / cashier
  { method: 'POST', test: /^\/api\/checkout$/, permission: 'dispense' },
  { method: 'GET', test: /^\/api\/billing\/(price|fees)$/, permission: 'view_summary' }, // pricing quote / schedule (BIL-001)
  { method: 'POST', test: /^\/api\/billing\/fee$/, permission: 'configure' }, // fee-schedule admin (BIL-001)
  { method: 'POST', test: /^\/api\/billing\/charge$/, permission: 'create' }, // priced service charge (BIL-001/003)
  { method: 'POST', test: /^\/api\/billing\/(payment|allocate|reallocate)$/, permission: 'receive_payment' },
  { method: 'POST', test: /^\/api\/billing\/refund$/, permission: 'reverse' },
  { method: 'GET', test: /^\/api\/billing\/invoice-outstanding$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/cashier\/(open|close)$/, permission: 'receive_payment' },
  { method: 'GET', test: /^\/api\/debtors\/ageing$/, permission: 'view_summary' },
  // Inventory
  { method: 'POST', test: /^\/api\/stock\/receive$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/stock\/stocktake$/, permission: 'approve' },
  { method: 'GET', test: /^\/api\/stock(\/alerts)?$/, permission: 'view_summary' },
  // Finance
  { method: 'POST', test: /^\/api\/finance\/(cost-centre|account|account\/revise|dimension|dimension\/value)$/, permission: 'configure' }, // chart/reference data (FIN-001)
  { method: 'POST', test: /^\/api\/finance\/journal\/draft$/, permission: 'create' }, // maker drafts (FIN-003)
  { method: 'POST', test: /^\/api\/finance\/(expense|pay-supplier|period\/close|period\/reopen|journal\/post|journal\/reject|monthly-close)$/, permission: 'approve' }, // checker/approver
  { method: 'GET', test: /^\/api\/finance\//, permission: 'view_summary' },
  // Documents
  { method: 'POST', test: /^\/api\/documents$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/documents\/open$/, permission: 'view_summary' },
  { method: 'GET', test: /^\/api\/documents\/disclosures$/, permission: 'view_summary' },
  // Management
  { method: 'GET', test: /^\/api\/management\/dashboard$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/management\/export$/, permission: 'export' },
  // Communication
  { method: 'POST', test: /^\/api\/comms\//, permission: 'create' },
  { method: 'GET', test: /^\/api\/comms\//, permission: 'view_summary' },
  // Operations
  { method: 'POST', test: /^\/api\/ops\/staff$/, permission: 'administer' },
  { method: 'POST', test: /^\/api\/ops\/task(\/complete)?$/, permission: 'create' },
  { method: 'GET', test: /^\/api\/ops\//, permission: 'view_summary' },
  // Administration
  { method: 'POST', test: /^\/api\/devices/, permission: 'administer' },
  { method: 'GET', test: /^\/api\/devices\/trusted$/, permission: 'view_summary' },
  { method: 'GET', test: /^\/api\/audit\/search$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/audit\/export$/, permission: 'export' },
];

/** The permission a route needs, or null if it is public (no auth). */
export function requiredPermission(method: string, pathname: string): Permission | null {
  const rule = RULES.find((r) => r.method === method && r.test.test(pathname));
  return rule ? rule.permission : null;
}

/** Deny-by-default check for a request. Returns the missing permission, or null if allowed. */
export function checkAuthorised(ctx: AuthContext, method: string, pathname: string): Permission | null {
  const perm = requiredPermission(method, pathname);
  if (perm === null) return null; // public route
  return can(ctx.roles, perm) ? null : perm;
}
