/**
 * Visit flow on D1 (VIS-001/003): check-in (start a visit + issue a queue token)
 * and the cross-device queue board. Ported from the Postgres edge `visits.ts`.
 *
 * Postgres used a sequence for the token; D1/SQLite has none, so the token is
 * `MAX(token)+1` computed inside a single `INSERT ... SELECT` (atomic within the
 * statement), then read back. Check-in commits the visit and its queue entry as
 * one atomic `batch()`.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class VisitError extends Error {}

export type QueueRow = { visitId: string; token: number; station: string; priority: number; status: string; patientMrn: string | null };

/** Check a patient in: open a visit and place it on the queue. Returns the token. */
export async function startVisit(
  db: D1Database,
  args: { patientId: string; station?: string; priority?: number; site?: string },
): Promise<{ visitId: string; token: number }> {
  const visitId = uuidv7();
  const queueId = uuidv7();
  const station = args.station ?? 'reception';
  const priority = args.priority ?? 100;
  await db.batch([
    stmt(db, `INSERT INTO flow_visit (id, patient_id, visit_number, site_id, status) VALUES (?,?,?,?,'open')`,
      [visitId, args.patientId, 'V-' + visitId.slice(-12), args.site ?? null]),
    // token = next running number; INSERT ... SELECT keeps it atomic in one statement.
    stmt(db, `INSERT INTO flow_queue_entry (id, visit_id, token, station, priority, status)
              SELECT ?, ?, COALESCE(MAX(token),0)+1, ?, ?, 'waiting' FROM flow_queue_entry`,
      [queueId, visitId, station, priority]),
  ]);
  const row = await one<{ token: number }>(db, `SELECT token FROM flow_queue_entry WHERE id=?`, [queueId]);
  return { visitId, token: Number(row?.token ?? 0) };
}

/** The queue board for a station (or all stations), waiting/served first. */
export async function queueBoard(db: D1Database, station?: string): Promise<QueueRow[]> {
  const rows = station
    ? await many<{ visit_id: string; token: number; station: string; priority: number; status: string; mrn: string | null }>(
        db,
        `SELECT q.visit_id, q.token, q.station, q.priority, q.status, p.mrn
         FROM flow_queue_entry q JOIN flow_visit v ON v.id=q.visit_id JOIN identity_patient p ON p.id=v.patient_id
         WHERE q.station=? AND q.status <> 'done' ORDER BY q.priority ASC, q.token ASC`,
        [station],
      )
    : await many<{ visit_id: string; token: number; station: string; priority: number; status: string; mrn: string | null }>(
        db,
        `SELECT q.visit_id, q.token, q.station, q.priority, q.status, p.mrn
         FROM flow_queue_entry q JOIN flow_visit v ON v.id=q.visit_id JOIN identity_patient p ON p.id=v.patient_id
         WHERE q.status <> 'done' ORDER BY q.station, q.priority ASC, q.token ASC`,
      );
  return rows.map((r) => ({ visitId: r.visit_id, token: Number(r.token), station: r.station, priority: Number(r.priority), status: r.status, patientMrn: r.mrn }));
}

// --- Transfer & completion (VIS-005/008) ------------------------------------

/** Move a visit's queue entry to another station (VIS-005). */
export async function transfer(db: D1Database, args: { visitId: string; toStation: string; priority?: number }): Promise<void> {
  const changed = await run(db, `UPDATE flow_queue_entry SET station=?, status='waiting', priority=COALESCE(?, priority), updated_at=${NOW} WHERE visit_id=?`,
    [args.toStation, args.priority ?? null, args.visitId]);
  if (changed === 0) throw new VisitError('visit has no queue entry');
}

/** Unresolved required tasks that block visit completion (VIS-008): unsigned
 * encounters on the visit, and unacknowledged critical results for the patient. */
export async function unresolvedTasks(db: D1Database, visitId: string): Promise<string[]> {
  const visit = await one<{ patient_id: string }>(db, `SELECT patient_id FROM flow_visit WHERE id=?`, [visitId]);
  if (!visit) throw new VisitError('visit not found');
  const unresolved: string[] = [];
  const drafts = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM clinical_encounter WHERE visit_id=? AND status IN ('draft','ready_to_sign')`, [visitId]);
  if (Number(drafts?.n ?? 0) > 0) unresolved.push(`${drafts!.n} unsigned encounter(s)`);
  const critical = await one<{ n: number }>(db,
    `SELECT COUNT(*) AS n FROM clinical_result r LEFT JOIN clinical_critical_result_ack a ON a.result_id=r.id WHERE r.patient_id=? AND r.critical=1 AND a.id IS NULL`, [visit.patient_id]);
  if (Number(critical?.n ?? 0) > 0) unresolved.push(`${critical!.n} unacknowledged critical result(s)`);
  return unresolved;
}

export type CompleteResult = { ok: true } | { ok: false; unresolved: string[] };

/** Complete a visit only when required tasks are resolved or overridden (VIS-008). */
export async function completeVisit(db: D1Database, args: { visitId: string; override?: boolean; reason?: string; user?: string }): Promise<CompleteResult> {
  const unresolved = await unresolvedTasks(db, args.visitId);
  if (unresolved.length > 0 && !args.override) return { ok: false, unresolved };
  const statements = [
    stmt(db, `UPDATE flow_visit SET status='complete', completed_at=${NOW} WHERE id=?`, [args.visitId]),
    stmt(db, `UPDATE flow_queue_entry SET status='done', updated_at=${NOW} WHERE visit_id=?`, [args.visitId]),
  ];
  if (unresolved.length > 0 && args.override) {
    statements.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','visit',?,'success',?,?)`,
      [uuidv7(), args.user ?? null, args.visitId, 'override close: ' + (args.reason ?? 'n/a') + ' [' + unresolved.join('; ') + ']', 'visit-override:' + args.visitId]));
  }
  await db.batch(statements);
  return { ok: true };
}
