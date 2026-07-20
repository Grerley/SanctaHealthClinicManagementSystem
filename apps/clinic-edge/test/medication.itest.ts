/**
 * Formulary search, dispensing worklist & printed prescription (MED-001/005/006)
 * against real PostgreSQL. Proves: the formulary is searched locally with live
 * on-hand stock; the dispensing worklist shows only signed, undispensed requests
 * and clears when marked; and a legally compliant prescription prints from signed
 * requests with prescriber registration + patient instructions.
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
import { searchFormulary, dispensingWorklist, markDispensed, generatePrescription, MedicationError } from '../src/medication.ts';
import { prescribe } from '../src/prescribing.ts';
import { addStaff } from '../src/ops.ts';

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

test('formulary search returns products with live on-hand stock (MED-001)', { skip }, async () => {
  const hits = await searchFormulary(pool, 'amox');
  const amox = hits.find((h) => h.sku === 'AMOX-500')!;
  assert.ok(amox, 'Amoxicillin should be found');
  assert.equal(amox.onHand, 1500); // 1000 + 500 from two available lots
  assert.equal((await searchFormulary(pool, 'nonexistent-drug')).length, 0);
});

test('dispensing worklist shows signed requests and clears when dispensed (MED-006)', { skip }, async () => {
  const staff = await addStaff(pool, { fullName: 'Dr Prescriber', role: 'clinical', registrationNo: 'MD-12345' });
  const rx = await prescribe(pool, { patientId: PATIENT, medicineCode: 'AMOX-500', substanceCode: 'amoxicillin', dose: '500mg', route: 'PO', frequency: 'TDS', durationDays: 5, quantity: 15, instructions: 'Take with food', prescribedBy: staff.staffId });
  assert.ok(rx.ok);

  let worklist = await dispensingWorklist(pool);
  const item = worklist.find((w) => w.requestId === (rx as { requestId: string }).requestId)!;
  assert.ok(item, 'signed request should be on the worklist');
  assert.equal(item.medicineCode, 'AMOX-500');

  await markDispensed(pool, { requestId: item.requestId, dispensedBy: staff.staffId });
  worklist = await dispensingWorklist(pool);
  assert.ok(!worklist.some((w) => w.requestId === item.requestId), 'dispensed request leaves the worklist');
  await assert.rejects(markDispensed(pool, { requestId: item.requestId }), /already dispensed/);
});

test('a legally compliant prescription prints from signed requests (MED-005)', { skip }, async () => {
  const staff = await addStaff(pool, { fullName: 'Dr Signer', role: 'clinical', registrationNo: 'MD-99999' });
  await prescribe(pool, { patientId: PATIENT, medicineCode: 'AMOX-500', substanceCode: 'amoxicillin', dose: '500mg', route: 'PO', frequency: 'BD', durationDays: 7, instructions: 'Complete the full course', prescribedBy: staff.staffId });

  const doc = await generatePrescription(pool, { patientId: PATIENT, prescriberId: staff.staffId, date: '2026-07-20' });
  assert.equal(doc.type, 'prescription');
  assert.ok(doc.sections.some((s) => s.lines.some((l) => l.includes('Amoxicillin'))));
  assert.ok(doc.sections.some((s) => s.lines.some((l) => l.includes('MD-99999')))); // prescriber registration
  assert.ok(doc.sections.some((s) => s.heading === 'Patient instructions' && s.lines.some((l) => l.includes('Complete the full course'))));

  await assert.rejects(generatePrescription(pool, { patientId: PATIENT, prescriberId: '00000000-0000-7000-8000-0000000009ff' }), MedicationError);
});
