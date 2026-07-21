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
  { method: 'POST', test: /^\/api\/patients\/related$/, permission: 'create' }, // PAT-005
  { method: 'GET', test: /^\/api\/patients\/related$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/patients\/access$/, permission: 'view_clinical_detail' }, // PAT-009
  { method: 'GET', test: /^\/api\/fhir\/Patient$/, permission: 'view_clinical_detail' }, // SYN-009 FHIR read (metadata is public)
  { method: 'POST', test: /^\/api\/patients\/(demographic|deceased)$/, permission: 'amend' },
  { method: 'POST', test: /^\/api\/patients\/summary\/export$/, permission: 'export' }, // PAT-010 authorised disclosure
  { method: 'GET', test: /^\/api\/patients\/disclosures$/, permission: 'view_summary' }, // PAT-010 disclosure log
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
  // EHR history / diagnoses / drafts (EHR-004/005/007)
  { method: 'POST', test: /^\/api\/ehr\/(history|history\/status|diagnosis|draft\/open|draft\/autosave)$/, permission: 'amend' },
  { method: 'GET', test: /^\/api\/ehr\/(history|diagnosis|diagnosis-codes)$/, permission: 'view_clinical_detail' },
  // Care plans (EHR-006) + clinical document generation (EHR-011)
  { method: 'POST', test: /^\/api\/ehr\/care-plan(\/(goal|followup|followup\/complete))?$/, permission: 'amend' },
  { method: 'GET', test: /^\/api\/ehr\/care-plans?(\/overdue)?$/, permission: 'view_clinical_detail' },
  { method: 'POST', test: /^\/api\/ehr\/document\/(visit-summary|prescription|sick-note|referral)$/, permission: 'view_clinical_detail' },
  { method: 'POST', test: /^\/api\/ehr\/handover(\/ack)?$/, permission: 'amend' }, // EHR-012
  { method: 'GET', test: /^\/api\/ehr\/inbox$/, permission: 'view_clinical_detail' },
  { method: 'GET', test: /^\/api\/patients\/timeline$/, permission: 'view_clinical_detail' }, // EHR-002
  { method: 'GET', test: /^\/api\/forms(\/get)?$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/forms$/, permission: 'configure' }, // EHR-003 form admin
  // Scheduling (APT). Deny-by-default (ADM-001): booking/capacity is a write, config is versioned.
  { method: 'GET', test: /^\/api\/schedule\/(next|type)$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/schedule\/(slot|book|status|reminder|waitlist|fill|reminder-queue)$/, permission: 'create' }, // incl. APT-004/005
  { method: 'POST', test: /^\/api\/schedule\/type$/, permission: 'configure' }, // APT-007 versioned types
  { method: 'POST', test: /^\/api\/triage\/(vitals|assessment|intervention)$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/triage\/sign$/, permission: 'sign' },
  { method: 'GET', test: /^\/api\/triage\/queue$/, permission: 'discover' },
  { method: 'GET', test: /^\/api\/triage\/summary$/, permission: 'view_clinical_detail' },
  { method: 'POST', test: /^\/api\/allergies$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/prescribe$/, permission: 'sign' },
  { method: 'POST', test: /^\/api\/prescribe\/template$/, permission: 'configure' }, // MED-004 define protocol
  { method: 'POST', test: /^\/api\/prescribe\/template\/apply$/, permission: 'view_clinical_detail' }, // MED-004 proposes only; confirm via /prescribe
  { method: 'POST', test: /^\/api\/prescribe\/administer$/, permission: 'dispense' }, // MED-009
  { method: 'GET', test: /^\/api\/prescribe\/administrations$/, permission: 'view_clinical_detail' }, // MED-009 MAR
  { method: 'GET', test: /^\/api\/formulary$/, permission: 'view_summary' }, // MED-001
  { method: 'GET', test: /^\/api\/dispense\/worklist$/, permission: 'view_summary' }, // MED-006
  { method: 'POST', test: /^\/api\/dispense\/mark$/, permission: 'dispense' },
  { method: 'POST', test: /^\/api\/prescription\/print$/, permission: 'view_clinical_detail' }, // MED-005
  { method: 'POST', test: /^\/api\/orders$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/orders\/(result|critical\/ack)$/, permission: 'amend' },
  { method: 'GET', test: /^\/api\/orders\/critical\/outstanding$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/orders\/(external-result|external-result\/reconcile|cancel|result\/correct)$/, permission: 'amend' }, // ORD-007/009
  { method: 'GET', test: /^\/api\/orders\/unmatched$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/orders\/set$/, permission: 'configure' }, // ORD-002 define order set (reference data)
  { method: 'POST', test: /^\/api\/orders\/set\/apply$/, permission: 'create' }, // ORD-002 apply → draft orders, still reviewed
  { method: 'POST', test: /^\/api\/orders\/specimen-label$/, permission: 'create' }, // ORD-004
  { method: 'POST', test: /^\/api\/referrals$/, permission: 'create' }, // ORD-008
  { method: 'POST', test: /^\/api\/referrals\/status$/, permission: 'amend' }, // ORD-008
  { method: 'GET', test: /^\/api\/referrals\/open$/, permission: 'view_summary' }, // ORD-008
  // Flow
  { method: 'POST', test: /^\/api\/visits\/(start|transfer|complete|hold|resume|outcome)$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/visits\/escalate$/, permission: 'amend' }, // VIS-004
  { method: 'GET', test: /^\/api\/visits\/(queue|durations)$/, permission: 'discover' },
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
  { method: 'GET', test: /^\/api\/stock(\/(alerts|reorder|movement-report))?$/, permission: 'view_summary' }, // incl. INV-007/011
  { method: 'POST', test: /^\/api\/procurement\/(requisition|purchase-order)$/, permission: 'create' }, // INV-003
  { method: 'POST', test: /^\/api\/procurement\/requisition\/decide$/, permission: 'approve' }, // INV-003 SoD approval
  { method: 'POST', test: /^\/api\/equipment$/, permission: 'create' }, // INV-010
  { method: 'POST', test: /^\/api\/equipment\/service$/, permission: 'amend' }, // INV-010
  { method: 'GET', test: /^\/api\/equipment\/due$/, permission: 'view_summary' }, // INV-010
  // Finance
  { method: 'POST', test: /^\/api\/finance\/(cost-centre|account|account\/revise|dimension|dimension\/value|budget)$/, permission: 'configure' }, // chart/reference data (FIN-001) + budgets (FIN-007)
  { method: 'POST', test: /^\/api\/finance\/journal\/draft$/, permission: 'create' }, // maker drafts (FIN-003)
  { method: 'POST', test: /^\/api\/finance\/(expense|pay-supplier|period\/close|period\/reopen|journal\/post|journal\/reject|monthly-close)$/, permission: 'approve' }, // checker/approver
  { method: 'POST', test: /^\/api\/finance\/break-even$/, permission: 'view_summary' }, // FIN-012 planning calc (no writes)
  { method: 'GET', test: /^\/api\/finance\/ledger-export$/, permission: 'export' }, // FIN-014 accounting-data export
  { method: 'GET', test: /^\/api\/finance\//, permission: 'view_summary' },
  // Documents
  { method: 'POST', test: /^\/api\/documents$/, permission: 'create' },
  { method: 'POST', test: /^\/api\/documents\/open$/, permission: 'view_summary' },
  { method: 'GET', test: /^\/api\/documents\/disclosures$/, permission: 'view_summary' },
  { method: 'POST', test: /^\/api\/documents\/generate$/, permission: 'create' }, // DOC-002
  { method: 'POST', test: /^\/api\/documents\/(supersede|entered-in-error|legal-hold|retention|dispose)$/, permission: 'administer' }, // DOC-003/005
  { method: 'GET', test: /^\/api\/documents\/disposal-candidates$/, permission: 'view_summary' },
  // Management
  { method: 'GET', test: /^\/api\/management\/(dashboard|kpi-comparison|scope|drill|commentary)$/, permission: 'view_summary' }, // scope MGT-002, drill MGT-006 (detail re-gated in-handler)
  { method: 'GET', test: /^\/api\/management\/analytical-extract$/, permission: 'export' }, // MGT-009 de-identified dataset
  { method: 'GET', test: /^\/api\/public\/queue$/, permission: 'discover' }, // VIS-009 de-identified public queue (content carries no PHI)
  { method: 'POST', test: /^\/api\/management\/export$/, permission: 'export' },
  { method: 'POST', test: /^\/api\/management\/kpi-target$/, permission: 'configure' }, // MGT-004
  { method: 'POST', test: /^\/api\/management\/kpi-snapshot$/, permission: 'view_summary' }, // MGT-005
  { method: 'POST', test: /^\/api\/management\/commentary$/, permission: 'view_summary' }, // MGT-010 (any dashboard viewer may annotate)
  // Communication
  { method: 'POST', test: /^\/api\/comms\//, permission: 'create' },
  { method: 'GET', test: /^\/api\/comms\//, permission: 'view_summary' },
  // Operations
  { method: 'POST', test: /^\/api\/ops\/staff$/, permission: 'administer' },
  { method: 'POST', test: /^\/api\/ops\/(resource|resource\/status|checklist|maintenance|maintenance\/complete)$/, permission: 'administer' }, // facility admin (OPS-002/004/006)
  { method: 'POST', test: /^\/api\/ops\/(checklist\/run|incident|incident\/update)$/, permission: 'create' }, // operational recording (OPS-004/005)
  { method: 'POST', test: /^\/api\/ops\/task(\/complete)?$/, permission: 'create' },
  { method: 'GET', test: /^\/api\/ops\//, permission: 'view_summary' },
  // Administration
  { method: 'GET', test: /^\/api\/sites$/, permission: 'view_summary' }, // OPS-008 multi-site
  { method: 'POST', test: /^\/api\/sites$/, permission: 'administer' },
  { method: 'GET', test: /^\/api\/admin\/(health|config|feature-flag)$/, permission: 'view_summary' }, // ADM-005/003/006
  { method: 'POST', test: /^\/api\/admin\/config-release(\/(promote|rollback))?$/, permission: 'configure' }, // ADM-003
  { method: 'POST', test: /^\/api\/admin\/feature-flag$/, permission: 'configure' }, // ADM-006
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
