/**
 * Financial period control on D1 (FIN-009, BR-010, UAT-13). A period is open,
 * soft- or hard-closed. Posting into a hard-closed period is rejected at the
 * posting choke point (`assertPeriodOpen`, called from journal-posting paths);
 * closing and reopening require an authorised approver and are audited. Ported
 * from the Postgres edge `finance.ts`. The finance_financial_period table already
 * exists (migration 0002).
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, run, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class PeriodClosedError extends Error {}
export class FinanceError extends Error {}

/** Reject posting into a hard-closed period (BR-010). Called before ledger writes. */
export async function assertPeriodOpen(db: D1Database, periodId: string): Promise<void> {
  const r = await one<{ status: string }>(db, `SELECT status FROM finance_financial_period WHERE id=?`, [periodId]);
  if (r && r.status === 'hard_close') {
    throw new PeriodClosedError(`period ${periodId} is closed; posting is rejected until it is reopened by an authorised user`);
  }
}

/** Hard-close a period. Requires an approver (segregation, BR-011). Audited. */
export async function closePeriod(db: D1Database, args: { periodId: string; approver?: string }): Promise<{ periodId: string; status: 'hard_close' }> {
  if (!args.approver) throw new FinanceError('closing a period requires an authorised approver');
  await run(db, `INSERT INTO finance_financial_period (id, status) VALUES (?, 'open') ON CONFLICT(id) DO NOTHING`, [args.periodId]);
  await db.batch([
    stmt(db, `UPDATE finance_financial_period SET status='hard_close', closed_at=${NOW} WHERE id=?`, [args.periodId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash)
              VALUES (?,?,'approve','financial_period',?,'success','period hard close',?)`, [uuidv7(), args.approver, args.periodId, 'period-close:' + args.periodId]),
  ]);
  return { periodId: args.periodId, status: 'hard_close' };
}

/** Reopen a hard-closed period with authority (FIN-009). Audited. */
export async function reopenPeriod(db: D1Database, args: { periodId: string; approver?: string; reason?: string }): Promise<{ periodId: string; status: 'open' }> {
  if (!args.approver) throw new FinanceError('reopening a period requires an authorised approver');
  await db.batch([
    stmt(db, `UPDATE finance_financial_period SET status='open', closed_at=NULL WHERE id=?`, [args.periodId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash)
              VALUES (?,?,'approve','financial_period',?,'success',?,?)`, [uuidv7(), args.approver, args.periodId, 'reopen: ' + (args.reason ?? 'n/a'), 'period-reopen:' + args.periodId]),
  ]);
  return { periodId: args.periodId, status: 'open' };
}

export async function periodStatus(db: D1Database, periodId: string): Promise<string | null> {
  const r = await one<{ status: string }>(db, `SELECT status FROM finance_financial_period WHERE id=?`, [periodId]);
  return r ? r.status : null;
}
