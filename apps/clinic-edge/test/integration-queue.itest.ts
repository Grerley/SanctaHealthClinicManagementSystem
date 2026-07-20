/**
 * Online-integration queue (SYN-010, CLD-003) against real PostgreSQL. Proves: an
 * integration is enqueued inside the local transaction and a failing delivery
 * never rolls back the local write; delivery has bounded retry and dead-letters
 * after max attempts (audited); a dead item can be replayed idempotently — and a
 * duplicate idempotency key is never delivered twice.
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
import { enqueueIntegration, drainIntegrations, replayDeadLetter, integrationQueueStatus, deadLetters, type Deliver } from '../src/integration-queue.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const OPERATOR = '00000000-0000-7000-8000-0000000000c1';

const alwaysFail: Deliver = async () => { throw new Error('external system unreachable'); };
function countingDeliver(): { deliver: Deliver; calls: () => number } {
  let n = 0;
  return { deliver: async () => { n++; }, calls: () => n };
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

test('a failing integration never rolls back the local transaction (SYN-010)', { skip }, async () => {
  // A local business write + an enqueue in ONE transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO audit.audit_event (id, action, resource_type, outcome, captured_at, event_hash) VALUES (gen_random_uuid(),'create','marker','success',now(),'marker-1')`);
    await enqueueIntegration(client, { kind: 'sms', payload: { to: '+100', body: 'reminder' }, idempotencyKey: 'sms-1', maxAttempts: 3 });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // Delivery fails — the local marker and queued item both survive; nothing rolled back.
  await drainIntegrations(pool, alwaysFail);
  const marker = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE event_hash='marker-1'`);
  assert.equal(marker.rows[0].n, 1);
  const q = await integrationQueueStatus(pool);
  assert.ok(q.queued >= 1 || q.dead >= 1);
});

test('delivery retries are bounded and dead-letter after max attempts (CLD-003)', { skip }, async () => {
  // sms-1 (max 3) has one failed attempt already; two more drains reach the DLQ.
  await drainIntegrations(pool, alwaysFail);
  await drainIntegrations(pool, alwaysFail);
  const dl = await deadLetters(pool);
  const item = dl.find((d) => d.kind === 'sms')!;
  assert.ok(item, 'sms-1 should be dead-lettered');
  assert.equal(item.attempts, 3);
  assert.match(item.lastError ?? '', /unreachable/);

  // The dead-letter transition is audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='integration_dead_letter' AND resource_id=$1`, [item.id]);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('a dead item replays idempotently and is delivered exactly once (CLD-003)', { skip }, async () => {
  const dl = await deadLetters(pool);
  const item = dl[0]!;
  const { deliver, calls } = countingDeliver();
  const res = await replayDeadLetter(pool, { id: item.id, by: OPERATOR }, deliver);
  assert.equal(res.status, 'delivered');
  assert.equal(calls(), 1);

  // Replaying an already-delivered item is refused (no second delivery).
  await assert.rejects(replayDeadLetter(pool, { id: item.id, by: OPERATOR }, deliver), /not dead/);
  assert.equal(calls(), 1);

  const q = await integrationQueueStatus(pool);
  assert.ok(q.delivered >= 1);
});

test('a duplicate idempotency key is never enqueued or delivered twice (NFR-010)', { skip }, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await enqueueIntegration(client, { kind: 'report', payload: { n: 1 }, idempotencyKey: 'dup-key' });
    await enqueueIntegration(client, { kind: 'report', payload: { n: 2 }, idempotencyKey: 'dup-key' }); // ignored
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const rows = await pool.query(`SELECT count(*)::int AS n FROM security_sync.integration_queue WHERE idempotency_key='dup-key'`);
  assert.equal(rows.rows[0].n, 1);

  const { deliver, calls } = countingDeliver();
  await drainIntegrations(pool, deliver);
  await drainIntegrations(pool, deliver); // second drain finds nothing queued for this key
  assert.equal(calls(), 1);
});
