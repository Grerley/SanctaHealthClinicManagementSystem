/**
 * Audit search and audited export on D1 (ADM-004, BR-012). Audit events are
 * append-only and cannot be edited (there is no update/delete path in application
 * code). Search is read-only; exporting audit data is itself an audited action, so
 * who looked at what is always recorded. Ported from the Postgres edge `audit.ts`.
 *
 * D1 translations: numbered placeholders → ?; the Postgres `received_at` ordering
 * column maps to the D1 audit_event `captured_at`.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many } from './query.ts';

export type AuditFilter = {
  user?: string;
  patientRef?: string;
  resourceType?: string;
  action?: string;
  fromIso?: string;
  toIso?: string;
  limit?: number;
};

export type AuditRow = {
  id: string;
  actorUser: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  patientRef: string | null;
  outcome: string;
  reason: string | null;
  capturedAt: string;
};

function buildWhere(f: AuditFilter): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => { params.push(val); conds.push(sql); };
  if (f.user) add('actor_user = ?', f.user);
  if (f.patientRef) add('patient_ref = ?', f.patientRef);
  if (f.resourceType) add('resource_type = ?', f.resourceType);
  if (f.action) add('action = ?', f.action);
  if (f.fromIso) add('captured_at >= ?', f.fromIso);
  if (f.toIso) add('captured_at <= ?', f.toIso);
  return { clause: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

export async function searchAudit(db: D1Database, f: AuditFilter): Promise<AuditRow[]> {
  const { clause, params } = buildWhere(f);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const rows = await many<{ id: string; actor_user: string | null; action: string; resource_type: string; resource_id: string | null; patient_ref: string | null; outcome: string; reason: string | null; captured_at: string }>(
    db,
    `SELECT id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at
     FROM audit_event ${clause}
     ORDER BY captured_at DESC
     LIMIT ?`,
    [...params, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    actorUser: r.actor_user,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    patientRef: r.patient_ref,
    outcome: r.outcome,
    reason: r.reason,
    capturedAt: r.captured_at,
  }));
}

/** Export audit rows AND record the export itself as an audit event (ADM-004). */
export async function exportAudit(db: D1Database, f: AuditFilter, exportedBy: string): Promise<{ rows: AuditRow[]; exportEventId: string }> {
  const rows = await searchAudit(db, f);
  const exportEventId = uuidv7();
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, outcome, reason, event_hash) VALUES (?,?,'export','audit','success',?,?)`)
    .bind(exportEventId, exportedBy, `exported ${rows.length} audit rows`, 'audit-export:' + exportEventId).run();
  return { rows, exportEventId };
}
