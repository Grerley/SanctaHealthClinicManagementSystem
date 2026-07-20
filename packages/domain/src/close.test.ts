import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingJournalLines } from './close.ts';
import { assertPostable, debitTotal, creditTotal, type JournalBatch } from './ledger.ts';

const RE = '3000-RETAINED-EARNINGS';

function asBatch(lines: ReturnType<typeof closingJournalLines>['lines']): JournalBatch {
  return { id: 'b', origin: 'manual', source: { type: 'period_close', id: '2026-07' }, currency: 'USD', postingDate: '2026-07-31', lines };
}

test('a profitable period closes to a balanced batch crediting retained earnings', () => {
  const r = closingJournalLines([{ code: '4000-SERVICE-REVENUE', amountMinor: 3000 }], [{ code: '5000-COGS', amountMinor: 1200 }], RE);
  assert.equal(r.revenueMinor, 3000);
  assert.equal(r.expensesMinor, 1200);
  assert.equal(r.netResultMinor, 1800);
  const batch = asBatch(r.lines);
  assert.doesNotThrow(() => assertPostable(batch));
  assert.equal(debitTotal(batch).minor, creditTotal(batch).minor);
  const re = r.lines.find((l) => l.accountCode === RE)!;
  assert.equal(re.credit.minor, 1800); // profit credits equity
  assert.equal(re.debit.minor, 0);
});

test('a loss-making period debits retained earnings and still balances', () => {
  const r = closingJournalLines([{ code: '4000-SERVICE-REVENUE', amountMinor: 500 }], [{ code: '6000-OPERATING-EXPENSE', amountMinor: 900 }], RE);
  assert.equal(r.netResultMinor, -400);
  const batch = asBatch(r.lines);
  assert.doesNotThrow(() => assertPostable(batch));
  const re = r.lines.find((l) => l.accountCode === RE)!;
  assert.equal(re.debit.minor, 400); // loss debits equity
  assert.equal(re.credit.minor, 0);
});

test('zero-balance temporary accounts are skipped', () => {
  const r = closingJournalLines(
    [{ code: '4000-SERVICE-REVENUE', amountMinor: 1000 }, { code: '4010-MEDICINE-REVENUE', amountMinor: 0 }],
    [{ code: '5000-COGS', amountMinor: 0 }],
    RE,
  );
  assert.ok(!r.lines.some((l) => l.accountCode === '4010-MEDICINE-REVENUE'));
  assert.ok(!r.lines.some((l) => l.accountCode === '5000-COGS'));
  assert.equal(r.netResultMinor, 1000);
});

test('a break-even period produces balancing lines with no retained-earnings posting', () => {
  const r = closingJournalLines([{ code: '4000-SERVICE-REVENUE', amountMinor: 1000 }], [{ code: '5000-COGS', amountMinor: 1000 }], RE);
  assert.equal(r.netResultMinor, 0);
  assert.ok(!r.lines.some((l) => l.accountCode === RE));
  const batch = asBatch(r.lines);
  assert.doesNotThrow(() => assertPostable(batch));
});
