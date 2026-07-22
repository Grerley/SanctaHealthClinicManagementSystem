/**
 * Controlled manual journal with maker-checker on D1 (FIN-003, BR-011). Runs on
 * real SQLite (same engine as D1). Proves: an unbalanced draft is rejected, the
 * maker cannot post their own draft (segregation), a checker posts a balanced
 * batch through the period-open choke point, and a rejected/posted journal can't
 * be posted again.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { draftManualJournal, approveManualJournal, rejectManualJournal, listManualJournals, ManualJournalError } from '../src/manual-journal.ts';
import { closePeriod, PeriodClosedError } from '../src/finance.ts';
import { trialBalance } from '../src/finance-reports.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
// A balanced pair of lines against seeded accounts (chart of accounts is in 0002).
const BALANCED = [
  { accountCode: '1000-CASH', debitMinor: 5000, creditMinor: 0 },
  { accountCode: '4010-MEDICINE-REVENUE', debitMinor: 0, creditMinor: 5000 },
];

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('an unbalanced draft is rejected immediately', async () => {
  await assert.rejects(() => draftManualJournal(db, { memo: 'bad', periodId: '2026-07', maker: 'm1', lines: [{ accountCode: '1000-CASH', debitMinor: 100, creditMinor: 0 }] }), Error);
});

test('maker-checker: the maker cannot post their own draft', async () => {
  const { journalId } = await draftManualJournal(db, { memo: 'accrual', periodId: '2026-07', maker: 'm1', lines: BALANCED });
  await assert.rejects(() => approveManualJournal(db, { journalId, checker: 'm1' }), Error); // same person
  const posted = await approveManualJournal(db, { journalId, checker: 'c1' });
  assert.equal(posted.status, 'posted');
  // The posted batch lands in the ledger and the trial balance still balances.
  const tb = await trialBalance(db);
  assert.equal(tb.balanced, true);
  // Re-posting is rejected.
  await assert.rejects(() => approveManualJournal(db, { journalId, checker: 'c2' }), ManualJournalError);
});

test('a checker can reject with a reason; a rejected journal cannot be posted', async () => {
  const { journalId } = await draftManualJournal(db, { memo: 'dubious', periodId: '2026-07', maker: 'm1', lines: BALANCED });
  await assert.rejects(() => rejectManualJournal(db, { journalId, checker: 'c1', reason: '' }), ManualJournalError);
  const r = await rejectManualJournal(db, { journalId, checker: 'c1', reason: 'no evidence' });
  assert.equal(r.status, 'rejected');
  await assert.rejects(() => approveManualJournal(db, { journalId, checker: 'c2' }), ManualJournalError);
  assert.equal((await listManualJournals(db, 'rejected')).length, 1);
});

test('posting into a hard-closed period is rejected at the choke point', async () => {
  const { journalId } = await draftManualJournal(db, { memo: 'late', periodId: '2026-07', maker: 'm1', lines: BALANCED });
  await closePeriod(db, { periodId: '2026-07', approver: 'cfo' });
  await assert.rejects(() => approveManualJournal(db, { journalId, checker: 'c1' }), PeriodClosedError);
});
