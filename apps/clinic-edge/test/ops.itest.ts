/**
 * Operations: staff credentials + tasks (OPS-001/003) against real PostgreSQL.
 * Proves: a valid credential passes and an expired/inactive one is flagged; an
 * overdue open task surfaces on the escalation queue and leaves it when completed.
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
import { addStaff, checkCredential, createTask, completeTask, overdueTasks, OpsError } from '../src/ops.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;

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

test('a valid credential passes; an expired one is flagged (OPS-001)', { skip }, async () => {
  const valid = await addStaff(pool, { fullName: 'Dr Synthetic', role: 'doctor', registrationNo: 'MDCZ-1', credentialExpiry: '2027-01-01' });
  assert.equal((await checkCredential(pool, valid.staffId, '2026-07-19')).valid, true);

  const expired = await addStaff(pool, { fullName: 'Nurse Synthetic', role: 'nurse', registrationNo: 'NC-1', credentialExpiry: '2026-01-01' });
  const chk = await checkCredential(pool, expired.staffId, '2026-07-19');
  assert.equal(chk.valid, false);
  assert.equal(chk.reason, 'expired');
});

test('staff without a credential cannot perform a credentialed action', { skip }, async () => {
  const s = await addStaff(pool, { fullName: 'Locum', role: 'doctor' });
  assert.equal((await checkCredential(pool, s.staffId, '2026-07-19')).reason, 'no_credential');
});

test('an overdue open task surfaces and leaves the queue when completed (OPS-003)', { skip }, async () => {
  const t = await createTask(pool, { subject: 'Reconcile mobile money', priority: 10, dueDate: '2026-07-10' });
  let overdue = await overdueTasks(pool, '2026-07-19');
  assert.ok(overdue.some((x) => x.taskId === t.taskId));

  await completeTask(pool, t.taskId);
  overdue = await overdueTasks(pool, '2026-07-19');
  assert.ok(!overdue.some((x) => x.taskId === t.taskId));
  await assert.rejects(completeTask(pool, t.taskId), OpsError); // already done
});

test('a future-dated task is not overdue', { skip }, async () => {
  const t = await createTask(pool, { subject: 'Quarterly stocktake', dueDate: '2026-12-01' });
  const overdue = await overdueTasks(pool, '2026-07-19');
  assert.ok(!overdue.some((x) => x.taskId === t.taskId));
});
