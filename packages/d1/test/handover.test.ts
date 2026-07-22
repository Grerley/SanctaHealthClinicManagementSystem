/**
 * Clinical handover & inbox on D1 (EHR-012). Runs on real SQLite. Proves: a
 * handover requires a recipient and message; acknowledgement happens once; and
 * the inbox surfaces unacknowledged items first.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendHandover, acknowledgeHandover, inbox, HandoverError } from '../src/handover.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('a handover requires a recipient and a message', async () => {
  await assert.rejects(() => sendHandover(db, { toStaff: '', message: 'hi' }), HandoverError);
  await assert.rejects(() => sendHandover(db, { toStaff: 'dr2', message: '  ' }), HandoverError);
});

test('acknowledgement happens exactly once', async () => {
  const { id } = await sendHandover(db, { toStaff: 'dr2', fromStaff: 'dr1', message: 'Please review Mr X labs' });
  assert.equal((await acknowledgeHandover(db, { id, by: 'dr2' })).status, 'acknowledged');
  await assert.rejects(() => acknowledgeHandover(db, { id, by: 'dr2' }), HandoverError);
});

test('inbox surfaces unacknowledged items first', async () => {
  await sendHandover(db, { toStaff: 'dr2', fromStaff: 'dr1', message: 'first' });
  const { id: second } = await sendHandover(db, { toStaff: 'dr2', fromStaff: 'dr1', message: 'second' });
  await acknowledgeHandover(db, { id: second, by: 'dr2' });
  const open = await inbox(db, 'dr2');
  assert.equal(open.length, 1); // acknowledged one hidden by default
  assert.equal(open[0]?.message, 'first');
  const all = await inbox(db, 'dr2', true);
  assert.equal(all.length, 2);
  assert.equal(all[0]?.status, 'open'); // open group first
});
