/**
 * Clinical handover/messages (EHR-012) + specialty form templates (EHR-010)
 * against real PostgreSQL. Proves: a handover reaches the recipient's inbox
 * (unacknowledged first) and is acknowledged once; and the seeded specialty
 * templates resolve and validate content through the versioned-forms mechanism.
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
import { validateFormContent } from '@sancta/domain';
import { sendHandover, acknowledgeHandover, inbox, HandoverError } from '../src/handover.ts';
import { formAsOf, listForms } from '../src/forms.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const NURSE = '00000000-0000-7000-8000-0000000000e1';
const DOCTOR = '00000000-0000-7000-8000-0000000000e2';

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

test('a handover reaches the inbox and is acknowledged once (EHR-012)', { skip }, async () => {
  const h = await sendHandover(pool, { fromStaff: NURSE, toStaff: DOCTOR, patientId: PATIENT, message: 'BP high, please review before discharge' });
  await assert.rejects(sendHandover(pool, { toStaff: DOCTOR, message: '' }), HandoverError);
  await assert.rejects(sendHandover(pool, { toStaff: '', message: 'x' }), HandoverError);

  const box = await inbox(pool, DOCTOR);
  assert.ok(box.some((i) => i.id === h.id && i.status === 'open' && i.patientId === PATIENT));
  assert.equal(box[0]!.status, 'open'); // unacknowledged first

  await acknowledgeHandover(pool, { id: h.id, by: DOCTOR });
  assert.ok(!(await inbox(pool, DOCTOR)).some((i) => i.id === h.id)); // gone from open inbox
  assert.ok((await inbox(pool, DOCTOR, true)).some((i) => i.id === h.id && i.status === 'acknowledged'));
  await assert.rejects(acknowledgeHandover(pool, { id: h.id, by: DOCTOR }), /already acknowledged/);
});

test('specialty templates resolve and validate content (EHR-010)', { skip }, async () => {
  const forms = await listForms(pool, '2026-07-20');
  for (const code of ['CHILD-HEALTH', 'FAMILY-PLANNING', 'WOUND-CARE']) {
    assert.ok(forms.some((f) => f.formCode === code), `${code} should be an active specialty template`);
  }
  const fp = await formAsOf(pool, 'FAMILY-PLANNING', '2026-07-20');
  // Valid content passes; an invalid coded option is rejected.
  assert.equal(validateFormContent(fp, { method: 'implant', counselling_done: true }).ok, true);
  assert.equal(validateFormContent(fp, { method: 'teleport', counselling_done: true }).ok, false);
  assert.equal(validateFormContent(fp, { counselling_done: true }).ok, false); // missing required method
});
