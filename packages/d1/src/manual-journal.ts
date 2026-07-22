/**
 * Controlled manual journal with maker-checker on D1 (FIN-003, BR-011). A maker
 * drafts a balanced journal (balance validated immediately via assertPostable); a
 * DIFFERENT checker posts it through the shared posting choke point (period-open
 * enforced) or rejects it with a reason. Posting builds a normal manual-origin
 * batch — it never edits an existing one. Ported from the Postgres edge
 * `manual-journal.ts`; the domain validators are reused unchanged.
 *
 * D1 translations: FOR UPDATE + interactive tx → a status read then a
 * status-guarded write inside db.batch(); the posting choke point is
 * ensurePeriod + assertPeriodOpen + journalStatements.
 */
import { uuidv7, assertSegregation, assertPostable, money, type JournalBatch, type JournalLine } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';
import { assertPeriodOpen } from './finance.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class ManualJournalError extends Error {}

export type DraftLine = { accountCode: string; debitMinor: number; creditMinor: number; memo?: string; costCentre?: string };
export type Attachment = { name: string; ref: string };

function toBatch(id: string, currency: string, periodId: string, lines: readonly DraftLine[]): JournalBatch {
  const journalLines: JournalLine[] = lines.map((l) => ({
    accountCode: l.accountCode,
    debit: money(l.debitMinor, currency),
    credit: money(l.creditMinor, currency),
    ...(l.memo === undefined ? {} : { memo: l.memo }),
    ...(l.costCentre === undefined ? {} : { costCentre: l.costCentre }),
  }));
  return { id, origin: 'manual', source: { type: 'manual_journal', id }, currency, postingDate: `${periodId}-01`, lines: journalLines };
}

/** Draft a manual journal. Validates balance immediately (assertPostable). */
export async function draftManualJournal(
  db: D1Database,
  args: { memo: string; periodId: string; lines: DraftLine[]; attachments?: Attachment[]; maker: string; currency?: string },
): Promise<{ journalId: string; status: 'draft' }> {
  if (!args.maker) throw new ManualJournalError('a maker is required');
  if (!args.memo?.trim()) throw new ManualJournalError('a memo is required (why this journal exists)');
  const currency = args.currency ?? 'USD';
  const journalId = uuidv7();
  assertPostable(toBatch(journalId, currency, args.periodId, args.lines)); // bad draft never reaches a checker
  await db.batch([
    stmt(db, `INSERT INTO finance_manual_journal (id, memo, currency, period_id, status, lines, attachments, maker_id) VALUES (?,?,?,?,'draft',?,?,?)`,
      [journalId, args.memo, currency, args.periodId, JSON.stringify(args.lines), JSON.stringify(args.attachments ?? []), args.maker]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'create','manual_journal',?,'success',?,?)`,
      [uuidv7(), args.maker, journalId, `drafted: ${args.memo}`, 'mj-draft:' + journalId]),
  ]);
  return { journalId, status: 'draft' };
}

/** Post a drafted manual journal as the checker (checker != maker, BR-011), through
 * the period-open choke point. Never posts a non-draft. */
export async function approveManualJournal(db: D1Database, args: { journalId: string; checker: string }): Promise<{ journalId: string; batchId: string; status: 'posted' }> {
  if (!args.checker) throw new ManualJournalError('a checker is required');
  const mj = await one<{ memo: string; currency: string; period_id: string; status: string; lines: string; maker_id: string }>(
    db, `SELECT memo, currency, period_id, status, lines, maker_id FROM finance_manual_journal WHERE id=?`, [args.journalId]);
  if (!mj) throw new ManualJournalError(`manual journal ${args.journalId} not found`);
  if (mj.status !== 'draft') throw new ManualJournalError(`manual journal ${args.journalId} is ${mj.status}, not draft`);
  assertSegregation(args.checker, mj.maker_id); // cannot post your own draft

  const batch = toBatch(uuidv7(), mj.currency, mj.period_id, JSON.parse(mj.lines) as DraftLine[]);
  assertPostable(batch);
  await ensurePeriod(db, mj.period_id);
  await assertPeriodOpen(db, mj.period_id); // BR-010
  await db.batch([
    ...journalStatements(db, batch, mj.period_id),
    // Guard on draft so a concurrent post can't double-apply.
    stmt(db, `UPDATE finance_manual_journal SET status='posted', checker_id=?, checked_at=${NOW}, batch_id=? WHERE id=? AND status='draft'`, [args.checker, batch.id, args.journalId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','manual_journal',?,'success',?,?)`,
      [uuidv7(), args.checker, args.journalId, `posted as batch ${batch.id} (memo: ${mj.memo})`, 'mj-post:' + args.journalId]),
  ]);
  return { journalId: args.journalId, batchId: batch.id, status: 'posted' };
}

/** Reject a drafted manual journal (checker declines). Audited; never posts. */
export async function rejectManualJournal(db: D1Database, args: { journalId: string; checker: string; reason: string }): Promise<{ journalId: string; status: 'rejected' }> {
  if (!args.checker) throw new ManualJournalError('a checker is required');
  if (!args.reason?.trim()) throw new ManualJournalError('a rejection reason is required');
  const mj = await one<{ status: string; maker_id: string }>(db, `SELECT status, maker_id FROM finance_manual_journal WHERE id=?`, [args.journalId]);
  if (!mj) throw new ManualJournalError(`manual journal ${args.journalId} not found`);
  if (mj.status !== 'draft') throw new ManualJournalError(`manual journal ${args.journalId} is ${mj.status}, not draft`);
  assertSegregation(args.checker, mj.maker_id);
  await db.batch([
    stmt(db, `UPDATE finance_manual_journal SET status='rejected', checker_id=?, checked_at=${NOW}, reject_reason=? WHERE id=? AND status='draft'`, [args.checker, args.reason, args.journalId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','manual_journal',?,'success',?,?)`,
      [uuidv7(), args.checker, args.journalId, `rejected: ${args.reason}`, 'mj-reject:' + args.journalId]),
  ]);
  return { journalId: args.journalId, status: 'rejected' };
}

export type ManualJournalRow = { id: string; memo: string; status: string; periodId: string; makerId: string; checkerId: string | null; batchId: string | null };

/** List manual journals, newest first, optionally filtered by status. */
export async function listManualJournals(db: D1Database, status?: string): Promise<ManualJournalRow[]> {
  const rows = status
    ? await many<{ id: string; memo: string; status: string; period_id: string; maker_id: string; checker_id: string | null; batch_id: string | null }>(
        db, `SELECT id, memo, status, period_id, maker_id, checker_id, batch_id FROM finance_manual_journal WHERE status=? ORDER BY made_at DESC`, [status])
    : await many<{ id: string; memo: string; status: string; period_id: string; maker_id: string; checker_id: string | null; batch_id: string | null }>(
        db, `SELECT id, memo, status, period_id, maker_id, checker_id, batch_id FROM finance_manual_journal ORDER BY made_at DESC`);
  return rows.map((row) => ({ id: row.id, memo: row.memo, status: row.status, periodId: row.period_id, makerId: row.maker_id, checkerId: row.checker_id, batchId: row.batch_id }));
}
