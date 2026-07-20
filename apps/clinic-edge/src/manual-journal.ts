/**
 * Controlled manual journal with maker-checker (FIN-003, BR-011, pack §10.1).
 *
 * A maker drafts a balanced journal with a memo and attachment references; a
 * DIFFERENT checker posts it. Posting builds a normal manual-origin batch through
 * the shared posting choke point (period-open enforced, FIN-009) — it never edits
 * an existing batch. Every step is audited. A draft that does not balance is
 * rejected at draft time by the ledger's `assertPostable`.
 */
import type { Pool } from 'pg';
import { uuidv7, assertSegregation, assertPostable, money, type JournalBatch, type JournalLine } from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';

export class ManualJournalError extends Error {}

export type DraftLine = { accountCode: string; debitMinor: number; creditMinor: number; memo?: string };
export type Attachment = { name: string; ref: string };

function toBatch(id: string, currency: string, periodId: string, lines: readonly DraftLine[]): JournalBatch {
  const journalLines: JournalLine[] = lines.map((l) => ({
    accountCode: l.accountCode,
    debit: money(l.debitMinor, currency),
    credit: money(l.creditMinor, currency),
    ...(l.memo === undefined ? {} : { memo: l.memo }),
  }));
  return { id, origin: 'manual', source: { type: 'manual_journal', id }, currency, postingDate: `${periodId}-01`, lines: journalLines };
}

/** Draft a manual journal. Validates balance immediately (assertPostable). */
export async function draftManualJournal(
  pool: Pool,
  args: { memo: string; periodId: string; lines: DraftLine[]; attachments?: Attachment[]; maker: string; currency?: string },
): Promise<{ journalId: string; status: 'draft' }> {
  if (!args.maker) throw new ManualJournalError('a maker is required');
  if (!args.memo?.trim()) throw new ManualJournalError('a memo is required (why this journal exists)');
  const currency = args.currency ?? 'USD';
  const journalId = uuidv7();
  // Balance/validity is checked now so a bad draft never reaches a checker.
  assertPostable(toBatch(journalId, currency, args.periodId, args.lines));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO finance.manual_journal (id, memo, currency, period_id, status, lines, attachments, maker_id)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7)`,
      [journalId, args.memo, currency, args.periodId, JSON.stringify(args.lines), JSON.stringify(args.attachments ?? []), args.maker],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','manual_journal',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.maker, journalId, `drafted: ${args.memo}`, 'mj-draft:' + journalId],
    );
    await client.query('COMMIT');
    return { journalId, status: 'draft' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Post a drafted manual journal as the checker. Enforces segregation of duties
 * (checker != maker, BR-011) and the period-open guard, then posts a balanced
 * manual-origin batch. Idempotent against re-posting a non-draft journal.
 */
export async function approveManualJournal(
  pool: Pool,
  args: { journalId: string; checker: string },
): Promise<{ journalId: string; batchId: string; status: 'posted' }> {
  if (!args.checker) throw new ManualJournalError('a checker is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT memo, currency, period_id, status, lines, maker_id FROM finance.manual_journal WHERE id=$1 FOR UPDATE`,
      [args.journalId],
    );
    if (r.rowCount === 0) throw new ManualJournalError(`manual journal ${args.journalId} not found`);
    const mj = r.rows[0];
    if (mj.status !== 'draft') throw new ManualJournalError(`manual journal ${args.journalId} is ${mj.status}, not draft`);
    assertSegregation(args.checker, mj.maker_id); // cannot post your own draft

    const batch = toBatch(uuidv7(), mj.currency, mj.period_id, mj.lines as DraftLine[]);
    assertPostable(batch);
    await insertJournalBatch(client, batch, mj.period_id); // enforces period open (BR-010)

    await client.query(
      `UPDATE finance.manual_journal SET status='posted', checker_id=$2, checked_at=now(), batch_id=$3 WHERE id=$1`,
      [args.journalId, args.checker, batch.id],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','manual_journal',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.checker, args.journalId, `posted as batch ${batch.id} (memo: ${mj.memo})`, 'mj-post:' + args.journalId],
    );
    await client.query('COMMIT');
    return { journalId: args.journalId, batchId: batch.id, status: 'posted' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Reject a drafted manual journal (checker declines). Audited; never posts. */
export async function rejectManualJournal(
  pool: Pool,
  args: { journalId: string; checker: string; reason: string },
): Promise<{ journalId: string; status: 'rejected' }> {
  if (!args.checker) throw new ManualJournalError('a checker is required');
  if (!args.reason?.trim()) throw new ManualJournalError('a rejection reason is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT status, maker_id FROM finance.manual_journal WHERE id=$1 FOR UPDATE`, [args.journalId]);
    if (r.rowCount === 0) throw new ManualJournalError(`manual journal ${args.journalId} not found`);
    if (r.rows[0].status !== 'draft') throw new ManualJournalError(`manual journal ${args.journalId} is ${r.rows[0].status}, not draft`);
    assertSegregation(args.checker, r.rows[0].maker_id);
    await client.query(`UPDATE finance.manual_journal SET status='rejected', checker_id=$2, checked_at=now(), reject_reason=$3 WHERE id=$1`, [args.journalId, args.checker, args.reason]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','manual_journal',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.checker, args.journalId, `rejected: ${args.reason}`, 'mj-reject:' + args.journalId],
    );
    await client.query('COMMIT');
    return { journalId: args.journalId, status: 'rejected' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type ManualJournalRow = { id: string; memo: string; status: string; periodId: string; makerId: string; checkerId: string | null; batchId: string | null };

/** List manual journals, newest first, optionally filtered by status. */
export async function listManualJournals(pool: Pool, status?: string): Promise<ManualJournalRow[]> {
  const r = status
    ? await pool.query(`SELECT id, memo, status, period_id, maker_id, checker_id, batch_id FROM finance.manual_journal WHERE status=$1 ORDER BY made_at DESC`, [status])
    : await pool.query(`SELECT id, memo, status, period_id, maker_id, checker_id, batch_id FROM finance.manual_journal ORDER BY made_at DESC`);
  return r.rows.map((row) => ({ id: row.id, memo: row.memo, status: row.status, periodId: row.period_id, makerId: row.maker_id, checkerId: row.checker_id, batchId: row.batch_id }));
}
