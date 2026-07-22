/**
 * Visit escalation, event log & outcomes on D1 (VIS-004/006/007, §5).
 *
 * VIS-004: raise a visit's clinical priority (emergency escalation) — a reason is
 * required and the change is audited.
 * VIS-006: every lifecycle action appends a visit event, giving automatic
 * waiting/start/end timestamps that reconcile to the visit's history (durations
 * are derived, never stored as editable totals).
 * VIS-007: hold/resume, and terminal outcomes (left-before-seen / refused /
 * cancelled) each with a reason.
 *
 * Ported from the Postgres edge `visit-lifecycle.ts`. D1 translations: interactive
 * tx + FOR UPDATE → read status then apply the change in one db.batch (the domain
 * assertTransition validates the move before the write); durations computed in JS
 * from stored ISO timestamps.
 */
import { uuidv7, assertTransition, VISIT_TRANSITIONS, type VisitState } from '@sancta/domain';
import type { D1Database, D1PreparedStatement } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class VisitLifecycleError extends Error {}

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

function eventStmt(db: D1Database, visitId: string, event: string, detail: string | null, actor: string | null): D1PreparedStatement {
  return stmt(db, `INSERT INTO flow_visit_event (id, visit_id, event, detail, actor) VALUES (?,?,?,?,?)`, [uuidv7(), visitId, event, detail, actor]);
}

async function currentStatus(db: D1Database, visitId: string): Promise<VisitState> {
  const r = await one<{ status: string }>(db, `SELECT status FROM flow_visit WHERE id=?`, [visitId]);
  if (!r) throw new VisitLifecycleError('visit not found');
  return r.status as VisitState;
}

/** Emergency escalation: raise priority with a required reason, audited (VIS-004). */
export async function escalateVisit(db: D1Database, args: { visitId: string; priority: number; reason: string; by: string }): Promise<{ visitId: string; priority: number }> {
  if (!args.reason?.trim()) throw new VisitLifecycleError('an escalation reason is required');
  if (!Number.isInteger(args.priority)) throw new VisitLifecycleError('priority must be an integer (lower = higher)');
  await currentStatus(db, args.visitId);
  await db.batch([
    stmt(db, `UPDATE flow_visit SET priority=? WHERE id=?`, [args.priority, args.visitId]),
    stmt(db, `UPDATE flow_queue_entry SET priority=? WHERE visit_id=?`, [args.priority, args.visitId]),
    eventStmt(db, args.visitId, 'escalated', `priority ${args.priority}: ${args.reason}`, args.by),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','visit',?,'success',?,?)`,
      [uuidv7(), args.by, args.visitId, `escalated to priority ${args.priority}: ${args.reason}`, 'escalate:' + args.visitId + ':' + uuidv7()]),
  ]);
  return { visitId: args.visitId, priority: args.priority };
}

/** Put a visit on hold (VIS-007). Reason recorded. */
export async function holdVisit(db: D1Database, args: { visitId: string; reason: string; by: string }): Promise<{ status: 'on_hold' }> {
  if (!args.reason?.trim()) throw new VisitLifecycleError('a hold reason is required');
  const from = await currentStatus(db, args.visitId);
  assertTransition(VISIT_TRANSITIONS, from, 'on_hold');
  await db.batch([
    stmt(db, `UPDATE flow_visit SET status='on_hold' WHERE id=?`, [args.visitId]),
    eventStmt(db, args.visitId, 'on_hold', args.reason, args.by),
  ]);
  return { status: 'on_hold' };
}

/** Resume a held visit to a station state (VIS-007). */
export async function resumeVisit(db: D1Database, args: { visitId: string; to: VisitState; by: string }): Promise<{ status: VisitState }> {
  const from = await currentStatus(db, args.visitId);
  assertTransition(VISIT_TRANSITIONS, from, args.to);
  const batch: D1PreparedStatement[] = [
    stmt(db, `UPDATE flow_visit SET status=? WHERE id=?`, [args.to, args.visitId]),
    eventStmt(db, args.visitId, 'resumed', args.to, args.by),
  ];
  if (args.to === 'in_care') batch.push(stmt(db, `UPDATE flow_visit SET started_at=COALESCE(started_at, ${NOW}) WHERE id=?`, [args.visitId]));
  await db.batch(batch);
  return { status: args.to };
}

const OUTCOMES = ['left_before_seen', 'refused', 'cancelled'] as const;

/** End a visit with a terminal outcome + reason (VIS-007). Audited; retained. */
export async function endVisitWithOutcome(db: D1Database, args: { visitId: string; outcome: string; reason: string; by: string }): Promise<{ status: 'cancelled'; outcome: string }> {
  if (!(OUTCOMES as readonly string[]).includes(args.outcome)) throw new VisitLifecycleError(`outcome must be one of ${OUTCOMES.join(', ')}`);
  if (!args.reason?.trim()) throw new VisitLifecycleError('a reason is required');
  const from = await currentStatus(db, args.visitId);
  if (from === 'complete' || from === 'cancelled') throw new VisitLifecycleError(`a ${from} visit cannot be ended`);
  assertTransition(VISIT_TRANSITIONS, from, 'cancelled');
  await db.batch([
    stmt(db, `UPDATE flow_visit SET status='cancelled', outcome=?, completed_at=${NOW} WHERE id=?`, [args.outcome, args.visitId]),
    stmt(db, `UPDATE flow_queue_entry SET status='done' WHERE visit_id=?`, [args.visitId]),
    eventStmt(db, args.visitId, args.outcome, args.reason, args.by),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','visit',?,'success',?,?)`,
      [uuidv7(), args.by, args.visitId, `${args.outcome}: ${args.reason}`, 'visit-outcome:' + args.visitId]),
  ]);
  return { status: 'cancelled', outcome: args.outcome };
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

function diffMinutes(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round((Date.parse(to) - Date.parse(from)) / 60000);
}

/**
 * Derived visit durations from the event log (VIS-006). Wait time is opened→
 * started; total is opened→ended. Reconciles to the recorded history.
 */
export async function visitDurations(db: D1Database, visitId: string): Promise<VisitDurations> {
  const v = await one<{ opened: string | null; started: string | null; ended: string | null }>(db,
    `SELECT created_at AS opened, started_at AS started, completed_at AS ended FROM flow_visit WHERE id=?`, [visitId]);
  if (!v) throw new VisitLifecycleError('visit not found');
  const events = await many<{ event: string; detail: string | null; at: string }>(db,
    `SELECT event, detail, occurred_at AS at FROM flow_visit_event WHERE visit_id=? ORDER BY occurred_at`, [visitId]);
  return {
    visitId,
    openedAt: v.opened,
    startedAt: v.started,
    endedAt: v.ended,
    waitMinutes: diffMinutes(v.opened, v.started),
    totalMinutes: diffMinutes(v.opened, v.ended),
    events: events.map((x) => ({ event: x.event, detail: x.detail, at: x.at })),
  };
}
