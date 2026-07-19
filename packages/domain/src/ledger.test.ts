import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, zero } from './money.ts';
import {
  type JournalBatch,
  type JournalLine,
  assertPostable,
  isBalanced,
  reverse,
  accountBalance,
  trialBalances,
  LedgerError,
} from './ledger.ts';

function line(accountCode: string, debit: number, credit: number): JournalLine {
  return { accountCode, debit: money(debit), credit: money(credit) };
}

function batch(id: string, lines: JournalLine[], origin: 'system' | 'manual' = 'system'): JournalBatch {
  return {
    id,
    origin,
    source: { type: 'invoice', id: 'inv-1' },
    currency: 'USD',
    postingDate: '2026-07-19',
    lines,
  };
}

test('a balanced batch is postable', () => {
  const b = batch('b1', [line('1200-AR', 5000, 0), line('4000-Revenue', 0, 5000)]);
  assert.ok(isBalanced(b));
  assert.doesNotThrow(() => assertPostable(b));
});

test('an unbalanced batch is rejected (BR-009)', () => {
  const b = batch('b2', [line('1200-AR', 5000, 0), line('4000-Revenue', 0, 4000)]);
  assert.equal(isBalanced(b), false);
  assert.throws(() => assertPostable(b), LedgerError);
});

test('a batch with no source reference is rejected (existence)', () => {
  const b = { ...batch('b3', [line('1200-AR', 100, 0), line('4000', 0, 100)]), source: { type: '', id: '' } };
  assert.throws(() => assertPostable(b), LedgerError);
});

test('a line cannot be both debit and credit', () => {
  const b = batch('b4', [line('1200-AR', 100, 100)]);
  assert.throws(() => assertPostable(b), LedgerError);
});

test('reversal swaps debits and credits and links to the original (BR-009)', () => {
  const original = batch('b5', [line('1200-AR', 5000, 0), line('4000-Revenue', 0, 5000)]);
  const rev = reverse(original, 'b5-rev', '2026-07-20');
  assert.equal(rev.reverses, 'b5');
  assert.doesNotThrow(() => assertPostable(rev));
  // original + reversal net every account to zero
  const combined = [original, rev];
  assert.equal(accountBalance(combined, '1200-AR').minor, 0);
  assert.equal(accountBalance(combined, '4000-Revenue').minor, 0);
});

test('account balance is debit-positive', () => {
  const b = batch('b6', [line('1200-AR', 5000, 0), line('4000-Revenue', 0, 5000)]);
  assert.equal(accountBalance([b], '1200-AR').minor, 5000);
  assert.equal(accountBalance([b], '4000-Revenue').minor, -5000);
});

test('trial balance over many batches nets to zero', () => {
  const b1 = batch('b7', [line('1200-AR', 5000, 0), line('4000-Revenue', 0, 5000)]);
  const b2 = batch('b8', [line('1000-Cash', 3000, 0), line('1200-AR', 0, 3000)]);
  assert.ok(trialBalances([b1, b2]));
});

test('an empty batch is rejected', () => {
  assert.throws(() => assertPostable(batch('b9', [])), LedgerError);
  assert.equal(zero().minor, 0);
});
