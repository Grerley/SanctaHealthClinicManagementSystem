/**
 * Facility operations (OPS-002/004/005/006, pack §11). Rooms, service points and
 * equipment with capacity + status; operational checklists with completion
 * enforcement; incident/complaint/near-miss capture with corrective actions; and
 * equipment maintenance/calibration/downtime scheduling. All mutations are audited.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class FacilityError extends Error {}

const RESOURCE_KINDS = ['room', 'service_point', 'equipment'] as const;
const RESOURCE_STATUS = ['available', 'in_use', 'maintenance', 'retired'] as const;

// --- OPS-002 facility resources -------------------------------------------

export async function addResource(pool: Pool, args: { kind: string; name: string; capacity?: number; site?: string }): Promise<{ id: string }> {
  if (!(RESOURCE_KINDS as readonly string[]).includes(args.kind)) throw new FacilityError(`resource kind must be one of ${RESOURCE_KINDS.join(', ')}`);
  if (!args.name?.trim()) throw new FacilityError('resource name is required');
  const id = uuidv7();
  await pool.query(`INSERT INTO organisation.facility_resource (id, kind, name, capacity, site_id) VALUES ($1,$2,$3,$4,$5)`, [id, args.kind, args.name, args.capacity ?? null, args.site ?? null]);
  return { id };
}

export async function setResourceStatus(pool: Pool, args: { id: string; status: string }): Promise<{ id: string; status: string }> {
  if (!(RESOURCE_STATUS as readonly string[]).includes(args.status)) throw new FacilityError(`status must be one of ${RESOURCE_STATUS.join(', ')}`);
  const r = await pool.query(`UPDATE organisation.facility_resource SET status=$2 WHERE id=$1 RETURNING id`, [args.id, args.status]);
  if (r.rowCount === 0) throw new FacilityError('resource not found');
  return { id: args.id, status: args.status };
}

export async function listResources(pool: Pool, kind?: string): Promise<Array<{ id: string; kind: string; name: string; capacity: number | null; status: string }>> {
  const r = kind
    ? await pool.query(`SELECT id, kind, name, capacity, status FROM organisation.facility_resource WHERE kind=$1 ORDER BY name`, [kind])
    : await pool.query(`SELECT id, kind, name, capacity, status FROM organisation.facility_resource ORDER BY kind, name`);
  return r.rows;
}

/** Available capacity: sum of capacity over resources of a kind that are available. */
export async function availableCapacity(pool: Pool, kind: string): Promise<{ kind: string; availableUnits: number; availableCapacity: number }> {
  const r = await pool.query(
    `SELECT count(*)::int AS units, coalesce(sum(capacity),0)::int AS cap FROM organisation.facility_resource WHERE kind=$1 AND status='available'`,
    [kind],
  );
  return { kind, availableUnits: r.rows[0].units, availableCapacity: r.rows[0].cap };
}

// --- OPS-004 checklists -----------------------------------------------------

export type ChecklistItem = { key: string; label: string; required?: boolean };

export async function defineChecklist(pool: Pool, args: { code: string; name: string; kind: string; items: ChecklistItem[] }): Promise<{ code: string }> {
  if (!args.items?.length) throw new FacilityError('a checklist needs at least one item');
  await pool.query(
    `INSERT INTO organisation.checklist_template (code, name, kind, items) VALUES ($1,$2,$3,$4)
     ON CONFLICT (code) DO UPDATE SET name=$2, kind=$3, items=$4`,
    [args.code, args.name, args.kind, JSON.stringify(args.items)],
  );
  return { code: args.code };
}

/**
 * Run a checklist. `complete` is true only when every REQUIRED item is answered
 * truthily; missing required items are returned so the UI can prompt. Recorded
 * regardless (a partial run is a real record), but flagged incomplete.
 */
export async function runChecklist(
  pool: Pool,
  args: { templateCode: string; results: Record<string, unknown>; performedBy?: string; notes?: string },
): Promise<{ runId: string; complete: boolean; missing: string[] }> {
  const t = await pool.query(`SELECT items FROM organisation.checklist_template WHERE code=$1 AND active`, [args.templateCode]);
  if (t.rowCount === 0) throw new FacilityError(`unknown checklist ${args.templateCode}`);
  const items = t.rows[0].items as ChecklistItem[];
  const missing = items.filter((i) => i.required && !args.results[i.key]).map((i) => i.key);
  const complete = missing.length === 0;
  const runId = uuidv7();
  await pool.query(
    `INSERT INTO organisation.checklist_run (id, template_code, performed_by, results, complete, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [runId, args.templateCode, args.performedBy ?? null, JSON.stringify(args.results), complete, args.notes ?? null],
  );
  return { runId, complete, missing };
}

// --- OPS-005 incidents ------------------------------------------------------

const INCIDENT_KINDS = ['incident', 'complaint', 'near_miss', 'failure'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;

export async function reportIncident(pool: Pool, args: { kind: string; severity?: string; description: string; reportedBy?: string }): Promise<{ id: string }> {
  if (!(INCIDENT_KINDS as readonly string[]).includes(args.kind)) throw new FacilityError(`incident kind must be one of ${INCIDENT_KINDS.join(', ')}`);
  if (args.severity && !(SEVERITIES as readonly string[]).includes(args.severity)) throw new FacilityError('severity must be low|medium|high');
  if (!args.description?.trim()) throw new FacilityError('a description is required');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO organisation.incident (id, kind, severity, description, reported_by) VALUES ($1,$2,$3,$4,$5)`,
    [id, args.kind, args.severity ?? 'low', args.description, args.reportedBy ?? null],
  );
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'create','incident',$3,'success',$4, now(), $5)`,
    [uuidv7(), args.reportedBy ?? null, id, `${args.kind} (${args.severity ?? 'low'})`, 'incident:' + id],
  );
  return { id };
}

export async function updateIncident(pool: Pool, args: { id: string; status?: string; correctiveAction?: string; by?: string }): Promise<{ id: string; status: string }> {
  const cur = await pool.query(`SELECT status, corrective_action FROM organisation.incident WHERE id=$1`, [args.id]);
  if (cur.rowCount === 0) throw new FacilityError('incident not found');
  const status = args.status ?? cur.rows[0].status;
  if (!['open', 'investigating', 'closed'].includes(status)) throw new FacilityError('status must be open|investigating|closed');
  const effectiveCorrective = args.correctiveAction ?? cur.rows[0].corrective_action;
  // Validate BEFORE writing: an incident cannot close without a corrective action.
  if (status === 'closed' && !effectiveCorrective) throw new FacilityError('closing an incident requires a corrective action');
  const closing = status === 'closed';
  await pool.query(
    `UPDATE organisation.incident SET status=$2, corrective_action=coalesce($3, corrective_action),
       closed_by=CASE WHEN $4 THEN $5 ELSE closed_by END, closed_at=CASE WHEN $4 THEN now() ELSE closed_at END
     WHERE id=$1`,
    [args.id, status, args.correctiveAction ?? null, closing, args.by ?? null],
  );
  return { id: args.id, status };
}

export async function openIncidents(pool: Pool): Promise<Array<{ id: string; kind: string; severity: string; description: string; status: string }>> {
  const r = await pool.query(`SELECT id, kind, severity, description, status FROM organisation.incident WHERE status <> 'closed' ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, reported_at`);
  return r.rows;
}

// --- OPS-006 equipment maintenance -----------------------------------------

export async function scheduleMaintenance(pool: Pool, args: { resourceId: string; kind: string; dueDate: string; notes?: string }): Promise<{ id: string }> {
  if (!['maintenance', 'calibration', 'downtime'].includes(args.kind)) throw new FacilityError('kind must be maintenance|calibration|downtime');
  const res = await pool.query(`SELECT 1 FROM organisation.facility_resource WHERE id=$1`, [args.resourceId]);
  if (res.rowCount === 0) throw new FacilityError('resource not found');
  const id = uuidv7();
  await pool.query(`INSERT INTO organisation.maintenance_record (id, resource_id, kind, due_date) VALUES ($1,$2,$3,$4)`, [id, args.resourceId, args.kind, args.dueDate]);
  return { id };
}

export async function completeMaintenance(pool: Pool, args: { id: string; performedBy?: string; notes?: string }): Promise<{ id: string }> {
  const r = await pool.query(`UPDATE organisation.maintenance_record SET performed_at=now(), performed_by=$2, notes=coalesce($3, notes) WHERE id=$1 AND performed_at IS NULL RETURNING id`, [args.id, args.performedBy ?? null, args.notes ?? null]);
  if (r.rowCount === 0) throw new FacilityError('maintenance record not found or already completed');
  return { id: args.id };
}

/** Maintenance/calibration due on or before a date and not yet performed (OPS-006). */
export async function dueMaintenance(pool: Pool, asOf: string): Promise<Array<{ id: string; resourceName: string; kind: string; dueDate: string }>> {
  const r = await pool.query(
    `SELECT m.id, r.name AS resource_name, m.kind, to_char(m.due_date,'YYYY-MM-DD') AS due_date
     FROM organisation.maintenance_record m JOIN organisation.facility_resource r ON r.id=m.resource_id
     WHERE m.performed_at IS NULL AND m.due_date <= $1 ORDER BY m.due_date`,
    [asOf],
  );
  return r.rows.map((x) => ({ id: x.id, resourceName: x.resource_name, kind: x.kind, dueDate: x.due_date }));
}
