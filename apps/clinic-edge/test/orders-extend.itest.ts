/**
 * Order sets, patient-safe specimen labels & outbound referrals
 * (ORD-002, ORD-004, ORD-008) against real PostgreSQL. Proves: applying an order
 * set creates individual DRAFT orders that still require per-patient review (never
 * auto-active); a specimen label carries positive ID but not the full name; a
 * referral tracks its lifecycle and rejects illegal transitions.
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
import { defineOrderSet, applyOrderSet, setOrderStatus, generateSpecimenLabel, createReferral, updateReferral, listOpenReferrals, OrderError } from '../src/orders.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
let PATIENT: string;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
    const r = await c.query(`SELECT id FROM identity.patient ORDER BY id LIMIT 1`);
    PATIENT = r.rows[0].id;
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('applying an order set creates DRAFT orders — per-patient review is not bypassed (ORD-002)', { skip }, async () => {
  await defineOrderSet(pool, {
    code: 'ANC-PANEL',
    name: 'Antenatal panel',
    items: [
      { category: 'laboratory', code: 'FBC' },
      { category: 'laboratory', code: 'BLOOD-GROUP' },
      { category: 'laboratory', code: 'URINALYSIS' },
    ],
  });
  const applied = await applyOrderSet(pool, { setCode: 'ANC-PANEL', patientId: PATIENT });
  assert.equal(applied.orderIds.length, 3);

  // Every created order is DRAFT — nothing is active until reviewed.
  const st = await pool.query(`SELECT status FROM clinical.service_request WHERE id = ANY($1)`, [applied.orderIds]);
  assert.ok(st.rows.every((r) => r.status === 'draft'));

  // A clinician reviews and activates one order individually.
  await setOrderStatus(pool, { orderId: applied.orderIds[0]!, to: 'active' });
  const one = await pool.query(`SELECT status FROM clinical.service_request WHERE id=$1`, [applied.orderIds[0]]);
  assert.equal(one.rows[0].status, 'active');

  // Applying an unknown set is rejected.
  await assert.rejects(applyOrderSet(pool, { setCode: 'NOPE', patientId: PATIENT }), OrderError);
});

test('a specimen label carries positive ID but not the full name (ORD-004)', { skip }, async () => {
  const applied = await applyOrderSet(pool, { setCode: 'ANC-PANEL', patientId: PATIENT });
  const orderId = applied.orderIds[0]!;
  const p = await pool.query(`SELECT given_name, family_name FROM identity.patient WHERE id=$1`, [PATIENT]);
  const label = await generateSpecimenLabel(pool, { orderId, collectedOn: '2026-07-21' });

  assert.match(label.accession, /^SPN-\d{6}$/);
  assert.match(label.line3, /21\/07\/2026/);
  const whole = [label.line1, label.line2, label.line3].join(' ').toLowerCase();
  const given = String(p.rows[0].given_name ?? '').toLowerCase();
  if (given) assert.ok(!whole.includes(given)); // full name never on the label

  // Accessions are unique per specimen.
  const label2 = await generateSpecimenLabel(pool, { orderId, collectedOn: '2026-07-21' });
  assert.notEqual(label.accession, label2.accession);
});

test('an outbound referral tracks acceptance, feedback & closure (ORD-008)', { skip }, async () => {
  const { id } = await createReferral(pool, { patientId: PATIENT, targetFacility: 'District Hospital', reason: 'Specialist review' });
  let open = await listOpenReferrals(pool);
  assert.ok(open.some((r) => r.id === id && r.status === 'sent'));

  await updateReferral(pool, { referralId: id, to: 'accepted' });
  await updateReferral(pool, { referralId: id, to: 'closed', feedback: 'Seen; managed and discharged' });

  const row = await pool.query(`SELECT status, feedback FROM clinical.referral WHERE id=$1`, [id]);
  assert.equal(row.rows[0].status, 'closed');
  assert.match(row.rows[0].feedback, /discharged/);

  // Closed → no further transitions; and a missing facility is rejected.
  await assert.rejects(updateReferral(pool, { referralId: id, to: 'accepted' }), OrderError);
  await assert.rejects(createReferral(pool, { patientId: PATIENT, targetFacility: '  ' }), OrderError);

  open = await listOpenReferrals(pool);
  assert.ok(!open.some((r) => r.id === id)); // closed referrals drop off the queue
});
