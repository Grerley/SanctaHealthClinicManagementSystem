/**
 * Sync conflict handling for patient demographics (SYN-006, pack §15.5).
 *
 * A demographic edit made offline on another site arrives with the ancestor it was
 * based on (`base`) plus the new values (`changes`). We 3-way merge against the
 * CURRENT edge record: fields only one side touched apply automatically; fields
 * both sides changed differently are never silently overwritten — we open a
 * `security_sync.conflict_case`, preserving both versions for a human to resolve
 * (a maker-checker decision, not last-write-wins). Auto-applied changes bump the
 * entity_version and are audited; conflicts are audited as detections.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7, mergeDemographics, resolveField, type FieldValue, type FieldConflict, type ConflictResolution } from '@sancta/domain';

export class ConflictQueueError extends Error {}

/** Columns we merge, mapped to the patient table. Kept narrow and identity-aware. */
const DEMOGRAPHIC_COLUMNS = ['given_name', 'family_name', 'date_of_birth', 'sex', 'phone'] as const;
type DemographicField = (typeof DEMOGRAPHIC_COLUMNS)[number];

export type DemographicUpdate = {
  patientId: string;
  /** Snapshot the offline edit was derived from (common ancestor). */
  base: Partial<Record<DemographicField, FieldValue>>;
  /** New values proposed by the incoming site. */
  changes: Partial<Record<DemographicField, FieldValue>>;
  originSite?: string;
  device?: string;
  user?: string;
};

export type DemographicUpdateResult = {
  applied: Record<string, FieldValue>;
  conflicts: FieldConflict[];
  conflictCaseId: string | null;
};

async function loadCurrent(client: PoolClient, patientId: string): Promise<Record<DemographicField, FieldValue>> {
  const r = await client.query(
    `SELECT given_name, family_name, to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth, sex, phone
     FROM identity.patient WHERE id=$1 FOR UPDATE`,
    [patientId],
  );
  if (r.rowCount === 0) throw new ConflictQueueError(`patient ${patientId} not found`);
  const row = r.rows[0];
  return {
    given_name: row.given_name ?? null,
    family_name: row.family_name ?? null,
    date_of_birth: row.date_of_birth ?? null,
    sex: row.sex ?? null,
    phone: row.phone ?? null,
  };
}

/**
 * Apply an incoming demographic update through a 3-way merge. Safe one-sided
 * changes are written; genuine conflicts open a conflict case and are left for a
 * human. The patient row is locked FOR UPDATE so concurrent applies serialise.
 */
export async function applyDemographicUpdate(pool: Pool, u: DemographicUpdate): Promise<DemographicUpdateResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await loadCurrent(client, u.patientId);
    const { applied, conflicts } = mergeDemographics(u.base, current, u.changes);

    // Apply the safe, one-sided fields in a single UPDATE, bumping the version.
    const appliedCols = Object.keys(applied).filter((k): k is DemographicField => (DEMOGRAPHIC_COLUMNS as readonly string[]).includes(k));
    if (appliedCols.length > 0) {
      const sets = appliedCols.map((c, i) => `${c}=$${i + 2}`);
      const vals = appliedCols.map((c) => applied[c] ?? null);
      await client.query(
        `UPDATE identity.patient SET ${sets.join(', ')}, entity_version = entity_version + 1 WHERE id=$1`,
        [u.patientId, ...vals],
      );
      await client.query(
        `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
         VALUES ($1,$2,'amend','patient',$3,$3,'success',$4, now(), $5)`,
        [uuidv7(), u.user ?? null, u.patientId, `sync-merged ${appliedCols.join(',')} from ${u.originSite ?? 'remote'}`, 'patient-merge:' + uuidv7()],
      );
    }

    let conflictCaseId: string | null = null;
    if (conflicts.length > 0) {
      conflictCaseId = uuidv7();
      await client.query(
        `INSERT INTO security_sync.conflict_case (id, entity_type, entity_id, status, local_version, incoming_version)
         VALUES ($1,'patient',$2,'open',$3,$4)`,
        [
          conflictCaseId,
          u.patientId,
          JSON.stringify(Object.fromEntries(conflicts.map((c) => [c.field, c.current]))),
          JSON.stringify(Object.fromEntries(conflicts.map((c) => [c.field, c.incoming]))),
        ],
      );
      await client.query(
        `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
         VALUES ($1,$2,'amend','conflict_case',$3,$4,'success',$5, now(), $6)`,
        [uuidv7(), u.user ?? null, conflictCaseId, u.patientId, `demographic conflict on ${conflicts.map((c) => c.field).join(',')} from ${u.originSite ?? 'remote'}`, 'conflict:' + conflictCaseId],
      );
    }

    await client.query('COMMIT');
    return { applied, conflicts, conflictCaseId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type OpenConflict = {
  id: string;
  entityType: string;
  entityId: string;
  detectedAt: string;
  localVersion: Record<string, FieldValue>;
  incomingVersion: Record<string, FieldValue>;
};

/** The human work queue: unresolved conflicts, oldest first (MGT-003). */
export async function listOpenConflicts(pool: Pool): Promise<OpenConflict[]> {
  const r = await pool.query(
    `SELECT id, entity_type, entity_id, to_char(detected_at,'DD/MM/YYYY HH24:MI') AS detected_at, local_version, incoming_version
     FROM security_sync.conflict_case WHERE status='open' ORDER BY detected_at ASC`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detectedAt: row.detected_at,
    localVersion: row.local_version,
    incomingVersion: row.incoming_version,
  }));
}

export type ResolveDecision = { field: string; decision: ConflictResolution; value?: FieldValue };

/**
 * Resolve an open conflict case with an explicit per-field decision (a human
 * maker-checker action). Writes the chosen values to the patient, bumps the
 * version, closes the case with the recorded resolution, and audits it. Refuses
 * to resolve an already-closed case.
 */
export async function resolveConflictCase(
  pool: Pool,
  args: { caseId: string; decisions: ResolveDecision[]; by: string },
): Promise<{ resolved: true; applied: Record<string, FieldValue> }> {
  if (!args.by) throw new ConflictQueueError('a resolver (by) is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cr = await client.query(
      `SELECT entity_type, entity_id, status, local_version, incoming_version
       FROM security_sync.conflict_case WHERE id=$1 FOR UPDATE`,
      [args.caseId],
    );
    if (cr.rowCount === 0) throw new ConflictQueueError(`conflict case ${args.caseId} not found`);
    const cse = cr.rows[0];
    if (cse.status !== 'open') throw new ConflictQueueError(`conflict case ${args.caseId} is already ${cse.status}`);
    if (cse.entity_type !== 'patient') throw new ConflictQueueError(`unsupported entity type ${cse.entity_type}`);

    const local = cse.local_version as Record<string, FieldValue>;
    const incoming = cse.incoming_version as Record<string, FieldValue>;
    const chosen: Record<string, FieldValue> = {};
    for (const d of args.decisions) {
      if (!(d.field in incoming)) throw new ConflictQueueError(`field ${d.field} is not part of this conflict`);
      const fc: FieldConflict = { field: d.field, base: null, current: local[d.field] ?? null, incoming: incoming[d.field] ?? null, identity: false };
      chosen[d.field] = resolveField(fc, d.decision, d.value);
    }

    const cols = Object.keys(chosen).filter((k) => (DEMOGRAPHIC_COLUMNS as readonly string[]).includes(k));
    if (cols.length > 0) {
      const sets = cols.map((c, i) => `${c}=$${i + 2}`);
      const vals = cols.map((c) => chosen[c] ?? null);
      await client.query(
        `UPDATE identity.patient SET ${sets.join(', ')}, entity_version = entity_version + 1 WHERE id=$1`,
        [cse.entity_id, ...vals],
      );
    }
    await client.query(
      `UPDATE security_sync.conflict_case SET status='resolved', resolution=$2 WHERE id=$1`,
      [args.caseId, JSON.stringify({ by: args.by, chosen, decisions: args.decisions })],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','conflict_case',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), args.by, args.caseId, cse.entity_id, `resolved ${cols.join(',')}`, 'conflict-resolve:' + args.caseId],
    );
    await client.query('COMMIT');
    return { resolved: true, applied: chosen };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
