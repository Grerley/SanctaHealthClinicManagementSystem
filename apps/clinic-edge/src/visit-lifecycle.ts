/**
 * Visit escalation, event log & outcomes (VIS-004/006/007, pack §5).
 *
 * VIS-004: raise a visit's clinical priority (emergency escalation) — a reason is
 * required and the change is audited.
 * VIS-006: every lifecycle action appends a visit event, giving automatic
 * waiting/start/end timestamps that reconcile to the visit's history (durations
 * are derived, never stored as editable totals).
 * VIS-007: hold/resume, and terminal outcomes (left-before-seen / refused /
 * cancelled) each with a reason.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7, assertTransition, VISIT_TRANSITIONS, type VisitState } from '@sancta/domain';

export class VisitLifecycleError extends Error {}

async function logEvent(client: PoolClient, visitId: string, event: string, detail: string | null, actor: string | null): Promise<void> {
  await client.query(`INSERT INTO flow.visit_event (id, visit_id, event, detail, actor) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), visitId, event, detail, actor]);
}

async function currentStatus(client: PoolClient, visitId: string): Promise<VisitState> {
  const r = await client.query(`SELECT status FROM flow.visit WHERE id=$1 FOR UPDATE`, [visitId]);
  if (r.rowCount === 0) throw new VisitLifecycleError('visit not found');
  return r.rows[0].status as VisitState;
}

/** Emergency escalation: raise priority with a required reason, audited (VIS-004). */
export async function escalateVisit(pool: Pool, args: { visitId: string; priority: number; reason: string; by: string }): Promise<{ visitId: string; priority: number }> {
  if (!args.reason?.trim()) throw new VisitLifecycleError('an escalation reason is required');
  if (!Number.isInteger(args.priority)) throw new VisitLifecycleError('priority must be an integer (lower = higher)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await currentStatus(client, args.visitId);
    await client.query(`UPDATE flow.visit SET priority=$2 WHERE id=$1`, [args.visitId, args.priority]);
    await client.query(`UPDATE flow.queue_entry SET priority=$2 WHERE visit_id=$1`, [args.visitId, args.priority]);
    await logEvent(client, args.visitId, 'escalated', `priority ${args.priority}: ${args.reason}`, args.by);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','visit',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by, args.visitId, `escalated to priority ${args.priority}: ${args.reason}`, 'escalate:' + args.visitId + ':' + uuidv7()],
    );
    await client.query('COMMIT');
    return { visitId: args.visitId, priority: args.priority };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Put a visit on hold (VIS-007). Reason recorded. */
export async function holdVisit(pool: Pool, args: { visitId: string; reason: string; by: string }): Promise<{ status: 'on_hold' }> {
  if (!args.reason?.trim()) throw new VisitLifecycleError('a hold reason is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const from = await currentStatus(client, args.visitId);
    assertTransition(VISIT_TRANSITIONS, from, 'on_hold');
    await client.query(`UPDATE flow.visit SET status='on_hold' WHERE id=$1`, [args.visitId]);
    await logEvent(client, args.visitId, 'on_hold', args.reason, args.by);
    await client.query('COMMIT');
    return { status: 'on_hold' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Resume a held visit to a station state (VIS-007). */
export async function resumeVisit(pool: Pool, args: { visitId: string; to: VisitState; by: string }): Promise<{ status: VisitState }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const from = await currentStatus(client, args.visitId);
    assertTransition(VISIT_TRANSITIONS, from, args.to);
    await client.query(`UPDATE flow.visit SET status=$2 WHERE id=$1`, [args.visitId, args.to]);
    await logEvent(client, args.visitId, 'resumed', args.to, args.by);
    if (args.to === 'in_care') await client.query(`UPDATE flow.visit SET started_at=coalesce(started_at, now()) WHERE id=$1`, [args.visitId]);
    await client.query('COMMIT');
    return { status: args.to };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const OUTCOMES = ['left_before_seen', 'refused', 'cancelled'] as const;

/** End a visit with a terminal outcome + reason (VIS-007). Audited; retained. */
export async function endVisitWithOutcome(pool: Pool, args: { visitId: string; outcome: string; reason: string; by: string }): Promise<{ status: 'cancelled'; outcome: string }> {
  if (!(OUTCOMES as readonly string[]).includes(args.outcome)) throw new VisitLifecycleError(`outcome must be one of ${OUTCOMES.join(', ')}`);
  if (!args.reason?.trim()) throw new VisitLifecycleError('a reason is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const from = await currentStatus(client, args.visitId);
    if (from === 'complete' || from === 'cancelled') throw new VisitLifecycleError(`a ${from} visit cannot be ended`);
    assertTransition(VISIT_TRANSITIONS, from, 'cancelled');
    await client.query(`UPDATE flow.visit SET status='cancelled', outcome=$2, completed_at=now() WHERE id=$1`, [args.visitId, args.outcome]);
    await client.query(`UPDATE flow.queue_entry SET status='done' WHERE visit_id=$1`, [args.visitId]);
    await logEvent(client, args.visitId, args.outcome, args.reason, args.by);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','visit',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by, args.visitId, `${args.outcome}: ${args.reason}`, 'visit-outcome:' + args.visitId],
    );
    await client.query('COMMIT');
    return { status: 'cancelled', outcome: args.outcome };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type VisitDurations = {
  visitId: string;
  openedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  waitMinutes: number | null;   // opened → started
  totalMinutes: number | null;  // opened → ended
  events: Array<{ event: string; detail: string | null; at: string }>;
};

/**
 * Derived visit durations from the event log (VIS-006). Wait time is opened→
 * started; total is opened→ended. Reconciles to the recorded history.
 */
export async function visitDurations(pool: Pool, visitId: string): Promise<VisitDurations> {
  const v = await pool.query(
    `SELECT to_char(opened_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS opened,
            to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started,
            to_char(completed_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended,
            extract(epoch FROM (started_at - opened_at))/60 AS wait_min,
            extract(epoch FROM (completed_at - opened_at))/60 AS total_min
     FROM flow.visit WHERE id=$1`,
    [visitId],
  );
  if (v.rowCount === 0) throw new VisitLifecycleError('visit not found');
  const ev = await pool.query(`SELECT event, detail, to_char(occurred_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM flow.visit_event WHERE visit_id=$1 ORDER BY occurred_at`, [visitId]);
  const row = v.rows[0];
  return {
    visitId,
    openedAt: row.opened,
    startedAt: row.started,
    endedAt: row.ended,
    waitMinutes: row.wait_min === null ? null : Math.round(Number(row.wait_min)),
    totalMinutes: row.total_min === null ? null : Math.round(Number(row.total_min)),
    events: ev.rows.map((x) => ({ event: x.event, detail: x.detail, at: x.at })),
  };
}
