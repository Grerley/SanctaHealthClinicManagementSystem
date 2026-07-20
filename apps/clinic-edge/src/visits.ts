/**
 * Visit flow: start/check-in, queue, transfer between stations, and completion
 * validation (VIS-001/003/005/008). The queue is visible across devices (a plain
 * table read, so it works offline on the LAN). A visit completes only when its
 * required tasks are resolved — draft encounters and unacknowledged critical
 * results — or an authorised override with a reason is supplied (VIS-008).
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

const DEFAULT_SITE = '00000000-0000-7000-8000-0000000000f1';

export class VisitError extends Error {}

export async function startVisit(pool: Pool, args: { patientId: string; station?: string; priority?: number; site?: string }): Promise<{ visitId: string; token: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const visitId = uuidv7();
    await client.query(`INSERT INTO flow.visit (id, patient_id, visit_number, site_id, status) VALUES ($1,$2,$3,$4,'open')`, [
      visitId,
      args.patientId,
      'V-' + visitId.slice(-12),
      args.site ?? DEFAULT_SITE,
    ]);
    const tokenRes = await client.query(`SELECT nextval('flow.queue_token_seq')::int AS t`);
    const token = tokenRes.rows[0].t as number;
    await client.query(`INSERT INTO flow.queue_entry (id, visit_id, token, station, priority, status) VALUES ($1,$2,$3,$4,$5,'waiting')`, [
      uuidv7(),
      visitId,
      token,
      args.station ?? 'reception',
      args.priority ?? 100,
    ]);
    await client.query('COMMIT');
    return { visitId, token };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Move a visit's queue entry to another station (VIS-005). */
export async function transfer(pool: Pool, args: { visitId: string; toStation: string; priority?: number }): Promise<void> {
  const r = await pool.query(
    `UPDATE flow.queue_entry SET station=$2, status='waiting', priority=coalesce($3, priority), updated_at=now() WHERE visit_id=$1`,
    [args.visitId, args.toStation, args.priority ?? null],
  );
  if (r.rowCount === 0) throw new VisitError('visit has no queue entry');
}

export type QueueRow = { visitId: string; token: number; station: string; priority: number; status: string; patientMrn: string | null };

/** The queue board for a station (or all). Visible across LAN devices (VIS-003). */
export async function queueBoard(pool: Pool, station?: string): Promise<QueueRow[]> {
  const res = station
    ? await pool.query(
        `SELECT q.visit_id, q.token, q.station, q.priority, q.status, p.mrn
         FROM flow.queue_entry q JOIN flow.visit v ON v.id=q.visit_id JOIN identity.patient p ON p.id=v.patient_id
         WHERE q.station=$1 AND q.status <> 'done' ORDER BY q.priority ASC, q.token ASC`,
        [station],
      )
    : await pool.query(
        `SELECT q.visit_id, q.token, q.station, q.priority, q.status, p.mrn
         FROM flow.queue_entry q JOIN flow.visit v ON v.id=q.visit_id JOIN identity.patient p ON p.id=v.patient_id
         WHERE q.status <> 'done' ORDER BY q.station, q.priority ASC, q.token ASC`,
      );
  return res.rows.map((r) => ({ visitId: r.visit_id, token: r.token, station: r.station, priority: r.priority, status: r.status, patientMrn: r.mrn }));
}

/** Unresolved required tasks that block visit completion (VIS-008). */
export async function unresolvedTasks(pool: Pool, visitId: string): Promise<string[]> {
  const unresolved: string[] = [];
  const patient = await pool.query(`SELECT patient_id FROM flow.visit WHERE id=$1`, [visitId]);
  if (patient.rows.length === 0) throw new VisitError('visit not found');
  const patientId = patient.rows[0].patient_id as string;

  const drafts = await pool.query(`SELECT count(*)::int AS n FROM clinical.encounter WHERE visit_id=$1 AND status IN ('draft','ready_to_sign')`, [visitId]);
  if (Number(drafts.rows[0].n) > 0) unresolved.push(`${drafts.rows[0].n} unsigned encounter(s)`);

  const critical = await pool.query(
    `SELECT count(*)::int AS n FROM clinical.result r
     LEFT JOIN clinical.critical_result_ack a ON a.result_id=r.id
     WHERE r.patient_id=$1 AND r.critical=true AND a.id IS NULL`,
    [patientId],
  );
  if (Number(critical.rows[0].n) > 0) unresolved.push(`${critical.rows[0].n} unacknowledged critical result(s)`);

  return unresolved;
}

export type CompleteResult = { ok: true } | { ok: false; unresolved: string[] };

/** Complete a visit only when required tasks are resolved or overridden (VIS-008). */
export async function completeVisit(pool: Pool, args: { visitId: string; override?: boolean; reason?: string; user?: string }): Promise<CompleteResult> {
  const unresolved = await unresolvedTasks(pool, args.visitId);
  if (unresolved.length > 0 && !args.override) {
    return { ok: false, unresolved };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE flow.visit SET status='complete', completed_at=now() WHERE id=$1`, [args.visitId]);
    await client.query(`UPDATE flow.queue_entry SET status='done', updated_at=now() WHERE visit_id=$1`, [args.visitId]);
    if (unresolved.length > 0 && args.override) {
      await client.query(
        `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
         VALUES ($1,$2,'approve','visit',$3,'success',$4, now(), $5)`,
        [uuidv7(), args.user ?? null, args.visitId, 'override close: ' + (args.reason ?? 'n/a') + ' [' + unresolved.join('; ') + ']', 'visit-override:' + args.visitId],
      );
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
