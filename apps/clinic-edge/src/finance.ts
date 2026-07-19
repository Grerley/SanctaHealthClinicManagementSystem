/**
 * Financial period control (FIN-009, BR-010, UAT-13). A period is open, soft-
 * closed or hard-closed. Posting into a hard-closed period is rejected; reopening
 * requires an authorised user and is audited. Periods are auto-created (open) on
 * first posting so a new month never fails for lack of a row.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class PeriodClosedError extends Error {}
export class FinanceError extends Error {}

/** Create the period (open) if it does not exist. Safe to call before posting. */
export async function ensurePeriod(client: PoolClient, periodId: string): Promise<void> {
  await client.query(`INSERT INTO finance.financial_period (id, status) VALUES ($1,'open') ON CONFLICT (id) DO NOTHING`, [periodId]);
}

/** Throw if the period is hard-closed (BR-010). Called at the posting choke point. */
export async function assertPeriodOpen(client: PoolClient, periodId: string): Promise<void> {
  const r = await client.query(`SELECT status FROM finance.financial_period WHERE id=$1`, [periodId]);
  if (r.rows.length > 0 && r.rows[0].status === 'hard_close') {
    throw new PeriodClosedError(`period ${periodId} is closed; posting is rejected until it is reopened by an authorised user`);
  }
}

/** Hard-close a period. Requires an approver (segregation, BR-011). */
export async function closePeriod(pool: Pool, args: { periodId: string; approver?: string }): Promise<{ periodId: string; status: 'hard_close' }> {
  if (!args.approver) throw new FinanceError('closing a period requires an authorised approver');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePeriod(client, args.periodId);
    await client.query(`UPDATE finance.financial_period SET status='hard_close', closed_at=now() WHERE id=$1`, [args.periodId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','financial_period',$3::uuid,'success','period hard close', now(), $4)`,
      [uuidv7(), args.approver, uuidv7(), 'period-close:' + args.periodId],
    );
    await client.query('COMMIT');
    return { periodId: args.periodId, status: 'hard_close' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Reopen a hard-closed period with authority (FIN-009). Audited. */
export async function reopenPeriod(pool: Pool, args: { periodId: string; approver?: string; reason?: string }): Promise<{ periodId: string; status: 'open' }> {
  if (!args.approver) throw new FinanceError('reopening a period requires an authorised approver');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE finance.financial_period SET status='open', closed_at=NULL WHERE id=$1`, [args.periodId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','financial_period',$3::uuid,'success',$4, now(), $5)`,
      [uuidv7(), args.approver, uuidv7(), 'reopen: ' + (args.reason ?? 'n/a'), 'period-reopen:' + args.periodId],
    );
    await client.query('COMMIT');
    return { periodId: args.periodId, status: 'open' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function periodStatus(pool: Pool, periodId: string): Promise<string | null> {
  const r = await pool.query(`SELECT status FROM finance.financial_period WHERE id=$1`, [periodId]);
  return r.rows.length > 0 ? (r.rows[0].status as string) : null;
}
