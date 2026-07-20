/**
 * Audit search and audited export (ADM-004, BR-012). Audit events are append-only
 * and cannot be edited (there is no update/delete path in application code, and
 * the store enforces immutability). Search is read-only; exporting audit data is
 * itself an audited action, so who looked at what is always recorded.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

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
  const add = (sql: string, val: unknown) => {
    params.push(val);
    conds.push(sql.replace('$?', `$${params.length}`));
  };
  if (f.user) add('actor_user = $?', f.user);
  if (f.patientRef) add('patient_ref = $?', f.patientRef);
  if (f.resourceType) add('resource_type = $?', f.resourceType);
  if (f.action) add('action = $?', f.action);
  if (f.fromIso) add('received_at >= $?', f.fromIso);
  if (f.toIso) add('received_at <= $?', f.toIso);
  return { clause: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

export async function searchAudit(pool: Pool, f: AuditFilter): Promise<AuditRow[]> {
  const { clause, params } = buildWhere(f);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  params.push(limit);
  const res = await pool.query(
    `SELECT id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason,
            to_char(captured_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at
     FROM audit.audit_event ${clause}
     ORDER BY received_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r) => ({
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
export async function exportAudit(pool: Pool, f: AuditFilter, exportedBy: string): Promise<{ rows: AuditRow[]; exportEventId: string }> {
  const rows = await searchAudit(pool, f);
  const exportEventId = uuidv7();
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'export','audit','success',$3, now(), $4)`,
    [exportEventId, exportedBy, `exported ${rows.length} audit rows`, 'audit-export:' + exportEventId],
  );
  return { rows, exportEventId };
}
