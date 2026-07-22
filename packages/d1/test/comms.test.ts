/**
 * Patient communication on D1 (COM-001..005). Runs on real SQLite (same engine as
 * D1). Proves: consent is checked before creation (non-consented → suppressed),
 * print is always allowed, a dedup key sends exactly once, and inbound replies
 * raise a task that can be closed.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setPreference, queueMessage, markSent, pendingMessages, recordInbound, openCommsTasks, completeCommsTask, CommsError } from '../src/comms.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'com-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('consent gates sending; print is always allowed', async () => {
  // No preference set → SMS defaults to suppressed, print allowed.
  const sms = await queueMessage(db, { patientId: PID, purpose: 'reminder', channel: 'sms', template: 'appt-24h', dedupKey: 'k1' });
  assert.equal(sms.status, 'suppressed');
  const print = await queueMessage(db, { patientId: PID, purpose: 'reminder', channel: 'print', template: 'appt-24h', dedupKey: 'k2' });
  assert.equal(print.status, 'queued');
  // Grant SMS consent → now queued.
  await setPreference(db, { patientId: PID, purpose: 'reminder', channel: 'sms', allowed: true });
  const sms2 = await queueMessage(db, { patientId: PID, purpose: 'reminder', channel: 'sms', template: 'appt-24h', dedupKey: 'k3' });
  assert.equal(sms2.status, 'queued');
});

test('a dedup key sends exactly once', async () => {
  await setPreference(db, { patientId: PID, purpose: 'billing', channel: 'sms', allowed: true });
  const first = await queueMessage(db, { patientId: PID, purpose: 'billing', channel: 'sms', template: 'statement', dedupKey: 'dup-1' });
  assert.equal(first.status, 'queued');
  const replay = await queueMessage(db, { patientId: PID, purpose: 'billing', channel: 'sms', template: 'statement', dedupKey: 'dup-1' });
  assert.equal(replay.status, 'duplicate'); // same dedup key → not re-created
  const pending = await pendingMessages(db);
  assert.equal(pending.filter((m) => m.patientId === PID).length, 1);
  await markSent(db, first.messageId);
  await assert.rejects(() => markSent(db, first.messageId), CommsError); // already sent
});

test('inbound replies raise a task that can be closed', async () => {
  const { taskId } = await recordInbound(db, { patientId: PID, body: 'Can I reschedule?', channel: 'sms' });
  assert.equal((await openCommsTasks(db)).length, 1);
  await completeCommsTask(db, { taskId, by: 'reception1' });
  assert.equal((await openCommsTasks(db)).length, 0);
  await assert.rejects(() => recordInbound(db, { body: '  ' }), CommsError);
});
