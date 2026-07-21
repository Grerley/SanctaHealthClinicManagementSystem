/**
 * Inbound→tasks, local help & replication scope (COM-004, ADM-008, SYN-008)
 * against real PostgreSQL. Proves: an inbound response raises a linked task that
 * can be closed; local help/onboarding content is served offline; and the
 * replication plan withholds out-of-scope (other-site / too-sensitive) records.
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
import { recordInbound, openCommsTasks, completeCommsTask, CommsError } from '../src/comms.ts';
import { getHelpTopic, listHelpTopics } from '../src/admin.ts';
import { replicationPlan } from '../src/site.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
let PATIENT: string;
let SITE: string;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
    SITE = '00000000-0000-7000-8000-0000000000f1'; // seeded MAIN site
    const r = await c.query(`SELECT id FROM identity.patient ORDER BY id LIMIT 1`);
    PATIENT = r.rows[0].id;
    await c.query(`UPDATE identity.patient SET site_id=$1 WHERE id=$2`, [SITE, PATIENT]);
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('an inbound response raises a linked task that can be closed (COM-004)', { skip }, async () => {
  const { inboundId, taskId } = await recordInbound(pool, { patientId: PATIENT, channel: 'sms', body: 'STOP reminders please', summary: 'Patient asked to stop reminders' });
  assert.ok(inboundId);

  let open = await openCommsTasks(pool);
  const task = open.find((t) => t.taskId === taskId);
  assert.ok(task);
  assert.equal(task!.inboundId, inboundId); // task is linked to its source (COM-004)

  await completeCommsTask(pool, { taskId, by: PATIENT });
  open = await openCommsTasks(pool);
  assert.ok(!open.some((t) => t.taskId === taskId)); // closed → off the queue

  // Closing again / empty body are rejected.
  await assert.rejects(completeCommsTask(pool, { taskId }), CommsError);
  await assert.rejects(recordInbound(pool, { body: '   ' }), CommsError);
});

test('local help & onboarding content is served offline (ADM-008)', { skip }, async () => {
  const topic = await getHelpTopic(pool, 'register-patient');
  assert.ok(topic);
  assert.equal(topic!.category, 'onboarding');

  // Onboarding steps come back in order.
  const onboarding = await listHelpTopics(pool, 'onboarding');
  assert.ok(onboarding.length >= 3);
  const steps = onboarding.filter((t) => t.stepOrder !== null).map((t) => t.stepOrder);
  assert.deepEqual(steps, [...steps].sort((a, b) => (a as number) - (b as number)));

  assert.equal(await getHelpTopic(pool, 'no-such-topic'), null);
});

test('the replication plan withholds out-of-scope records (SYN-008)', { skip }, async () => {
  // Make one patient sensitive to prove the sensitivity ceiling withholds it.
  await pool.query(`UPDATE identity.patient SET sensitivity='restricted' WHERE id=$1`, [PATIENT]);

  // A local node for SITE with a 'sensitive' ceiling.
  const plan = await replicationPlan(pool, { scope: { sites: [SITE], maxSensitivity: 'sensitive', windowDays: 3650 }, asOf: '2026-07-21' });
  assert.ok(plan.replicated >= 0);
  assert.ok(plan.withheld >= 1); // at least the restricted patient is withheld
  // The restricted patient is not in the replicated sample.
  assert.ok(!plan.sample.some((s) => s.patientId === PATIENT));

  // A central node (all sites, restricted ceiling) holds more than the local node.
  const central = await replicationPlan(pool, { scope: { sites: 'all', maxSensitivity: 'restricted' }, asOf: '2026-07-21' });
  assert.ok(central.replicated >= plan.replicated);
});
