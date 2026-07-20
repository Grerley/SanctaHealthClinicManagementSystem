/**
 * Controlled manual journal (FIN-003, maker-checker) + month-end close loop and
 * balance sheet (FIN-004, FIN-010) against real PostgreSQL. Proves: a maker
 * cannot post their own journal; a checker posts a balanced batch that lands in
 * the ledger; an unbalanced draft is rejected; monthly close clears revenue and
 * expense to retained earnings, the period cannot be closed twice, posting into a
 * closed period is blocked, and the balance sheet balances throughout.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { draftManualJournal, approveManualJournal, rejectManualJournal, ManualJournalError } from '../src/manual-journal.ts';
import { balanceSheet, monthlyClose } from '../src/finance-close.ts';
import { trialBalance } from '../src/finance-reports.ts';
import { PeriodClosedError } from '../src/finance.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const MAKER = '00000000-0000-7000-8000-0000000000a1';
const CHECKER = '00000000-0000-7000-8000-0000000000a2';
const PERIOD = '2026-08';

async function accountNet(code: string): Promise<number> {
  const tb = await trialBalance(pool);
  const row = tb.rows.find((r) => r.code === code);
  return row ? row.netMinor : 0;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('an unbalanced manual journal is rejected at draft time (FIN-002)', { skip }, async () => {
  await assert.rejects(
    draftManualJournal(pool, {
      memo: 'lopsided',
      periodId: PERIOD,
      lines: [{ accountCode: '1000-CASH', debitMinor: 100, creditMinor: 0 }, { accountCode: '4000-SERVICE-REVENUE', debitMinor: 0, creditMinor: 50 }],
      maker: MAKER,
    }),
    /unbalanced/,
  );
});

test('a maker cannot post their own journal; a checker can (FIN-003, BR-011)', { skip }, async () => {
  const { journalId } = await draftManualJournal(pool, {
    memo: 'record donated cash',
    periodId: PERIOD,
    lines: [
      { accountCode: '1000-CASH', debitMinor: 5000, creditMinor: 0, memo: 'grant' },
      { accountCode: '4000-SERVICE-REVENUE', debitMinor: 0, creditMinor: 5000, memo: 'grant income' },
    ],
    attachments: [{ name: 'grant-letter', ref: 'doc://grant/2026-08' }],
    maker: MAKER,
  });

  // Segregation: the maker is refused.
  await assert.rejects(approveManualJournal(pool, { journalId, checker: MAKER }), /segregation/);

  // A different checker posts it — it reaches the ledger.
  const before = await accountNet('1000-CASH');
  const res = await approveManualJournal(pool, { journalId, checker: CHECKER });
  assert.equal(res.status, 'posted');
  assert.ok(res.batchId);
  assert.equal(await accountNet('1000-CASH'), before + 5000);

  // Re-posting a posted journal is refused.
  await assert.rejects(approveManualJournal(pool, { journalId, checker: CHECKER }), ManualJournalError);

  // It is audited (drafted + posted).
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='manual_journal' AND resource_id=$1`, [journalId]);
  assert.ok((audit.rows[0].n as number) >= 2);
});

test('a checker can reject a draft with a reason; it never posts (FIN-003)', { skip }, async () => {
  const { journalId } = await draftManualJournal(pool, {
    memo: 'questionable adjustment',
    periodId: PERIOD,
    lines: [{ accountCode: '6000-OPERATING-EXPENSE', debitMinor: 200, creditMinor: 0 }, { accountCode: '1000-CASH', debitMinor: 0, creditMinor: 200 }],
    maker: MAKER,
  });
  await assert.rejects(rejectManualJournal(pool, { journalId, checker: CHECKER, reason: '' }), ManualJournalError);
  const res = await rejectManualJournal(pool, { journalId, checker: CHECKER, reason: 'no supporting evidence' });
  assert.equal(res.status, 'rejected');
  await assert.rejects(approveManualJournal(pool, { journalId, checker: CHECKER }), /rejected/);
});

test('the balance sheet balances (assets = liabilities + equity)', { skip }, async () => {
  const bs = await balanceSheet(pool);
  assert.equal(bs.balances, true);
  assert.equal(bs.assetsMinor, bs.liabilitiesMinor + bs.equityMinor);
});

test('monthly close clears revenue/expense to retained earnings and cannot repeat (FIN-004)', { skip }, async () => {
  // Post an expense in the period so there is a net result to close.
  const { journalId } = await draftManualJournal(pool, {
    memo: 'august rent',
    periodId: PERIOD,
    lines: [{ accountCode: '6000-OPERATING-EXPENSE', debitMinor: 1500, creditMinor: 0 }, { accountCode: '1000-CASH', debitMinor: 0, creditMinor: 1500 }],
    maker: MAKER,
  });
  await approveManualJournal(pool, { journalId, checker: CHECKER });

  // Revenue 5000 (from the earlier grant) − expense 1500 = 3500 net profit.
  const reBefore = await accountNet('3000-RETAINED-EARNINGS');
  const bsBefore = await balanceSheet(pool);
  assert.equal(bsBefore.balances, true);

  const close = await monthlyClose(pool, { periodId: PERIOD, approver: CHECKER });
  assert.equal(close.status, 'hard_close');
  assert.equal(close.revenueMinor, 5000);
  assert.equal(close.expensesMinor, 1500);
  assert.equal(close.netResultMinor, 3500);
  assert.ok(close.closingBatchId);

  // Temporary accounts are now flat for the period; retained earnings holds the net.
  assert.equal(await accountNet('4000-SERVICE-REVENUE'), 0);
  assert.equal(await accountNet('6000-OPERATING-EXPENSE'), 0);
  // Retained earnings is credit-normal → net -3500 in debit-positive terms.
  assert.equal(await accountNet('3000-RETAINED-EARNINGS'), reBefore - 3500);

  // The balance sheet still balances after the close (earnings reclassified within equity).
  const bsAfter = await balanceSheet(pool);
  assert.equal(bsAfter.balances, true);
  assert.equal(bsAfter.equityMinor, bsBefore.equityMinor);

  // A closed period cannot be closed again, and posting into it is blocked.
  await assert.rejects(monthlyClose(pool, { periodId: PERIOD, approver: CHECKER }), PeriodClosedError);
  const draft = await draftManualJournal(pool, {
    memo: 'late entry',
    periodId: PERIOD,
    lines: [{ accountCode: '6000-OPERATING-EXPENSE', debitMinor: 10, creditMinor: 0 }, { accountCode: '1000-CASH', debitMinor: 0, creditMinor: 10 }],
    maker: MAKER,
  });
  await assert.rejects(approveManualJournal(pool, { journalId: draft.journalId, checker: CHECKER }), /closed/);
});
