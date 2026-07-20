/**
 * Patient communication (COM-001/002/003) against real PostgreSQL. Proves:
 * without consent an SMS is suppressed (not sent); with consent it is queued;
 * a duplicate dedup key does not create a second message (send once); print is
 * always available.
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
import { setPreference, queueMessage, markSent, pendingMessages } from '../src/comms.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';

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

test('without consent an SMS is suppressed, not sent (COM-001)', { skip }, async () => {
  const r = await queueMessage(pool, { patientId: PATIENT, purpose: 'reminder', channel: 'sms', template: 'appt-reminder', dedupKey: 'k1' });
  assert.equal(r.status, 'suppressed');
});

test('with consent the SMS is queued and can be marked sent', { skip }, async () => {
  await setPreference(pool, { patientId: PATIENT, purpose: 'reminder', channel: 'sms', allowed: true });
  const r = await queueMessage(pool, { patientId: PATIENT, purpose: 'reminder', channel: 'sms', template: 'appt-reminder', dedupKey: 'k2' });
  assert.equal(r.status, 'queued');
  assert.ok((await pendingMessages(pool)).some((m) => m.messageId === r.messageId));
  await markSent(pool, r.messageId);
  assert.ok(!(await pendingMessages(pool)).some((m) => m.messageId === r.messageId));
});

test('a duplicate dedup key does not create a second message (send once, COM-002)', { skip }, async () => {
  await setPreference(pool, { patientId: PATIENT, purpose: 'reminder', channel: 'sms', allowed: true });
  const a = await queueMessage(pool, { patientId: PATIENT, purpose: 'reminder', channel: 'sms', template: 't', dedupKey: 'same' });
  const b = await queueMessage(pool, { patientId: PATIENT, purpose: 'reminder', channel: 'sms', template: 't', dedupKey: 'same' });
  assert.equal(a.status, 'queued');
  assert.equal(b.status, 'duplicate');
  const n = await pool.query(`SELECT count(*)::int AS n FROM flow.message WHERE dedup_key='same'`);
  assert.equal(n.rows[0].n, 1);
});

test('print is always available even without a preference (assisted printing, COM-005)', { skip }, async () => {
  const r = await queueMessage(pool, { patientId: PATIENT, purpose: 'billing', channel: 'print', template: 'statement', dedupKey: 'p1' });
  assert.equal(r.status, 'queued');
});
