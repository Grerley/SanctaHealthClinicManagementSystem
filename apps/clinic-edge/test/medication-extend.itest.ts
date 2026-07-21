/**
 * Prescribing protocol templates & medication administration (MED-004, MED-009)
 * against real PostgreSQL. Proves: applying a template only PROPOSES lines and
 * never bypasses the allergy check on confirmation; an administration record
 * captures time/dose/route/site/performer and a not-given event needs a reason.
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
import { recordAllergy, prescribe, defineRxTemplate, applyRxTemplate, recordAdministration, listAdministrations, PrescribingError } from '../src/prescribing.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
let PATIENT: string;
const PRESCRIBER = '00000000-0000-7000-8000-0000000000a1';

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

test('a protocol template proposes lines but never bypasses the allergy check (MED-004)', { skip }, async () => {
  await defineRxTemplate(pool, {
    code: 'URTI',
    name: 'Upper respiratory tract infection',
    items: [
      { medicineCode: 'AMOX-500', substanceCode: 'AMOXICILLIN', dose: '500mg', route: 'PO', frequency: 'TDS', durationDays: 5, quantity: 15 },
      { medicineCode: 'PARA-500', substanceCode: 'PARACETAMOL', dose: '1g', route: 'PO', frequency: 'QDS', durationDays: 3, quantity: 12 },
    ],
  });

  // The patient is allergic to amoxicillin.
  await recordAllergy(pool, { patientId: PATIENT, substanceCode: 'AMOXICILLIN', severity: 'high' });

  const applied = await applyRxTemplate(pool, { templateCode: 'URTI' });
  assert.equal(applied.proposals.length, 2);
  assert.ok(applied.proposals.every((p) => p.requiresConfirmation === true));

  // Applying the template creates ZERO medication requests — it only proposes.
  const none = await pool.query(`SELECT count(*)::int AS n FROM clinical.medication_request WHERE patient_id=$1`, [PATIENT]);
  assert.equal(none.rows[0].n, 0);

  // Confirming the amoxicillin line still hits the allergy check (not bypassed).
  const amox = applied.proposals.find((p) => p.substanceCode === 'AMOXICILLIN')!;
  const blocked = await prescribe(pool, { patientId: PATIENT, prescribedBy: PRESCRIBER, medicineCode: amox.medicineCode, substanceCode: amox.substanceCode, ...(amox.dose ? { dose: amox.dose } : {}) });
  assert.equal(blocked.ok, false); // allergy alert

  // The safe line confirms normally.
  const para = applied.proposals.find((p) => p.substanceCode === 'PARACETAMOL')!;
  const ok = await prescribe(pool, { patientId: PATIENT, prescribedBy: PRESCRIBER, medicineCode: para.medicineCode, substanceCode: para.substanceCode });
  assert.equal(ok.ok, true);
});

test('medication administration records time/dose/route/site/performer (MED-009)', { skip }, async () => {
  const rx = await prescribe(pool, { patientId: PATIENT, prescribedBy: PRESCRIBER, medicineCode: 'PARA-500', substanceCode: 'PARACETAMOL', dose: '1g', route: 'PO' });
  assert.ok(rx.ok);
  const requestId = rx.ok ? rx.requestId : '';

  await recordAdministration(pool, { requestId, performer: PRESCRIBER, dose: '1g', route: 'PO', site: 'oral', administeredAt: '2026-07-21T08:00:00Z' });
  await recordAdministration(pool, { requestId, performer: PRESCRIBER, status: 'not_given', reason: 'patient nil by mouth', administeredAt: '2026-07-21T14:00:00Z' });

  const mar = await listAdministrations(pool, { requestId });
  assert.equal(mar.length, 2);
  assert.equal(mar[0]!.status, 'given');
  assert.equal(mar[0]!.site, 'oral');
  assert.equal(mar[1]!.status, 'not_given');
  assert.match(mar[1]!.reason ?? '', /nil by mouth/);

  // A not-given event without a reason is rejected.
  await assert.rejects(recordAdministration(pool, { requestId, status: 'not_given' }), PrescribingError);
  // An unknown request is rejected.
  await assert.rejects(recordAdministration(pool, { requestId: '00000000-0000-7000-8000-0000000000ff' }), PrescribingError);
});
