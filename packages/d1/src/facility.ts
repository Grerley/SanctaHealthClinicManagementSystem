/**
 * Facility operations on D1 (OPS-002/004/005/006, §11). Rooms, service points and
 * equipment with capacity + status; operational checklists with completion
 * enforcement; incident/complaint/near-miss capture with corrective actions; and
 * equipment maintenance/calibration/downtime scheduling. All mutations are audited.
 * Ported from the Postgres edge `facility.ts`.
 *
 * D1 translations: boolean complete/active → INTEGER 0/1; JSON columns as TEXT
 * (JSON.parse/stringify); RETURNING-guarded UPDATEs → run() rowcount; the incident
 * close-requires-corrective-action check runs BEFORE the write.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

export class FacilityError extends Error {}

const RESOURCE_KINDS = ['room', 'service_point', 'equipment'] as const;
const RESOURCE_STATUS = ['available', 'in_use', 'maintenance', 'retired'] as const;

// --- OPS-002 facility resources -------------------------------------------

export async function addResource(db: D1Database, args: { kind: string; name: string; capacity?: number; site?: string }): Promise<{ id: string }> {
  if (!(RESOURCE_KINDS as readonly string[]).includes(args.kind)) throw new FacilityError(`resource kind must be one of ${RESOURCE_KINDS.join(', ')}`);
  if (!args.name?.trim()) throw new FacilityError('resource name is required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO organisation_facility_resource (id, kind, name, capacity, site_id) VALUES (?,?,?,?,?)`).bind(id, args.kind, args.name, args.capacity ?? null, args.site ?? null).run();
  return { id };
}

export async function setResourceStatus(db: D1Database, args: { id: string; status: string }): Promise<{ id: string; status: string }> {
  if (!(RESOURCE_STATUS as readonly string[]).includes(args.status)) throw new FacilityError(`status must be one of ${RESOURCE_STATUS.join(', ')}`);
  const changed = await run(db, `UPDATE organisation_facility_resource SET status=? WHERE id=?`, [args.status, args.id]);
  if (changed === 0) throw new FacilityError('resource not found');
  return { id: args.id, status: args.status };
}

export async function listResources(db: D1Database, kind?: string): Promise<Array<{ id: string; kind: string; name: string; capacity: number | null; status: string }>> {
  return kind
    ? many(db, `SELECT id, kind, name, capacity, status FROM organisation_facility_resource WHERE kind=? ORDER BY name`, [kind])
    : many(db, `SELECT id, kind, name, capacity, status FROM organisation_facility_resource ORDER BY kind, name`);
}

/** Available capacity: sum of capacity over resources of a kind that are available. */
export async function availableCapacity(db: D1Database, kind: string): Promise<{ kind: string; availableUnits: number; availableCapacity: number }> {
  const r = await one<{ units: number; cap: number }>(db, `SELECT COUNT(*) AS units, COALESCE(SUM(capacity),0) AS cap FROM organisation_facility_resource WHERE kind=? AND status='available'`, [kind]);
  return { kind, availableUnits: Number(r?.units ?? 0), availableCapacity: Number(r?.cap ?? 0) };
}

// --- OPS-004 checklists -----------------------------------------------------

export type ChecklistItem = { key: string; label: string; required?: boolean };

export async function defineChecklist(db: D1Database, args: { code: string; name: string; kind: string; items: ChecklistItem[] }): Promise<{ code: string }> {
  if (!args.items?.length) throw new FacilityError('a checklist needs at least one item');
  await db.prepare(`INSERT INTO organisation_checklist_template (code, name, kind, items) VALUES (?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, kind=excluded.kind, items=excluded.items`)
    .bind(args.code, args.name, args.kind, JSON.stringify(args.items)).run();
  return { code: args.code };
}

/**
 * Run a checklist. `complete` is true only when every REQUIRED item is answered
 * truthily; missing required items are returned so the UI can prompt. Recorded
 * regardless (a partial run is a real record), but flagged incomplete.
 */
export async function runChecklist(
  db: D1Database,
  args: { templateCode: string; results: Record<string, unknown>; performedBy?: string; notes?: string },
): Promise<{ runId: string; complete: boolean; missing: string[] }> {
  const t = await one<{ items: string }>(db, `SELECT items FROM organisation_checklist_template WHERE code=? AND active=1`, [args.templateCode]);
  if (!t) throw new FacilityError(`unknown checklist ${args.templateCode}`);
  const items = JSON.parse(t.items) as ChecklistItem[];
  const missing = items.filter((i) => i.required && !args.results[i.key]).map((i) => i.key);
  const complete = missing.length === 0;
  const runId = uuidv7();
  await db.prepare(`INSERT INTO organisation_checklist_run (id, template_code, performed_by, results, complete, notes) VALUES (?,?,?,?,?,?)`)
    .bind(runId, args.templateCode, args.performedBy ?? null, JSON.stringify(args.results), complete ? 1 : 0, args.notes ?? null).run();
  return { runId, complete, missing };
}

// --- OPS-005 incidents ------------------------------------------------------

const INCIDENT_KINDS = ['incident', 'complaint', 'near_miss', 'failure'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;

export async function reportIncident(db: D1Database, args: { kind: string; severity?: string; description: string; reportedBy?: string }): Promise<{ id: string }> {
  if (!(INCIDENT_KINDS as readonly string[]).includes(args.kind)) throw new FacilityError(`incident kind must be one of ${INCIDENT_KINDS.join(', ')}`);
  if (args.severity && !(SEVERITIES as readonly string[]).includes(args.severity)) throw new FacilityError('severity must be low|medium|high');
  if (!args.description?.trim()) throw new FacilityError('a description is required');
  const id = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO organisation_incident (id, kind, severity, description, reported_by) VALUES (?,?,?,?,?)`, [id, args.kind, args.severity ?? 'low', args.description, args.reportedBy ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'create','incident',?,'success',?,?)`,
      [uuidv7(), args.reportedBy ?? null, id, `${args.kind} (${args.severity ?? 'low'})`, 'incident:' + id]),
  ]);
  return { id };
}

export async function updateIncident(db: D1Database, args: { id: string; status?: string; correctiveAction?: string; by?: string }): Promise<{ id: string; status: string }> {
  const cur = await one<{ status: string; corrective_action: string | null }>(db, `SELECT status, corrective_action FROM organisation_incident WHERE id=?`, [args.id]);
  if (!cur) throw new FacilityError('incident not found');
  const status = args.status ?? cur.status;
  if (!['open', 'investigating', 'closed'].includes(status)) throw new FacilityError('status must be open|investigating|closed');
  const effectiveCorrective = args.correctiveAction ?? cur.corrective_action;
  // Validate BEFORE writing: an incident cannot close without a corrective action.
  if (status === 'closed' && !effectiveCorrective) throw new FacilityError('closing an incident requires a corrective action');
  const closing = status === 'closed';
  await run(db,
    `UPDATE organisation_incident SET status=?, corrective_action=COALESCE(?, corrective_action),
       closed_by=CASE WHEN ? THEN ? ELSE closed_by END, closed_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE closed_at END
     WHERE id=?`,
    [status, args.correctiveAction ?? null, closing ? 1 : 0, args.by ?? null, closing ? 1 : 0, args.id]);
  return { id: args.id, status };
}

export async function openIncidents(db: D1Database): Promise<Array<{ id: string; kind: string; severity: string; description: string; status: string }>> {
  return many(db, `SELECT id, kind, severity, description, status FROM organisation_incident WHERE status <> 'closed' ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, reported_at`);
}

// --- OPS-006 equipment maintenance -----------------------------------------

export async function scheduleMaintenance(db: D1Database, args: { resourceId: string; kind: string; dueDate: string; notes?: string }): Promise<{ id: string }> {
  if (!['maintenance', 'calibration', 'downtime'].includes(args.kind)) throw new FacilityError('kind must be maintenance|calibration|downtime');
  const res = await one<{ x: number }>(db, `SELECT 1 AS x FROM organisation_facility_resource WHERE id=?`, [args.resourceId]);
  if (!res) throw new FacilityError('resource not found');
  const id = uuidv7();
  await db.prepare(`INSERT INTO organisation_maintenance_record (id, resource_id, kind, due_date) VALUES (?,?,?,?)`).bind(id, args.resourceId, args.kind, args.dueDate).run();
  return { id };
}

export async function completeMaintenance(db: D1Database, args: { id: string; performedBy?: string; notes?: string }): Promise<{ id: string }> {
  const changed = await run(db, `UPDATE organisation_maintenance_record SET performed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), performed_by=?, notes=COALESCE(?, notes) WHERE id=? AND performed_at IS NULL`, [args.performedBy ?? null, args.notes ?? null, args.id]);
  if (changed === 0) throw new FacilityError('maintenance record not found or already completed');
  return { id: args.id };
}

/** Maintenance/calibration due on or before a date and not yet performed (OPS-006). */
export async function dueMaintenance(db: D1Database, asOf: string): Promise<Array<{ id: string; resourceName: string; kind: string; dueDate: string }>> {
  const rows = await many<{ id: string; resource_name: string; kind: string; due_date: string }>(db,
    `SELECT m.id, r.name AS resource_name, m.kind, m.due_date FROM organisation_maintenance_record m JOIN organisation_facility_resource r ON r.id=m.resource_id
     WHERE m.performed_at IS NULL AND m.due_date <= ? ORDER BY m.due_date`, [asOf]);
  return rows.map((x) => ({ id: x.id, resourceName: x.resource_name, kind: x.kind, dueDate: x.due_date }));
}
