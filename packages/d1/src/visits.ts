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
import { one, many, stmt } from './query.ts';

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
