/**
 * Formulary / dispensing worklist / printed prescription on D1 (MED-001/005/006).
 * Runs on real SQLite (same engine as D1). Proves: formulary search returns live
 * stock, the worklist shows only signed undispensed requests and clears on
 * dispense, and a prescription prints from the signed requests.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchFormulary, dispensingWorklist, markDispensed, generatePrescription, MedicationError } from '../src/medication.ts';
import { prescribe } from '../src/prescribing.ts';
import { receiveGoods } from '../src/inventory.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations, applyD1Seeds } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'med-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await applyD1Seeds(db); // seeds the AMOX-500 product + demo stock
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-040001', 'Med', 'Pt').run();
});

test('formulary search returns live stock for available lots', async () => {
  const items = await searchFormulary(db, 'amox');
  const amox = items.find((i) => i.sku === 'AMOX-500');
  assert.ok(amox);
  assert.ok(amox!.onHand > 0); // demo seed stocked it
});

test('worklist shows signed undispensed requests and clears on dispense', async () => {
  const rx = await prescribe(db, { patientId: PID, medicineCode: 'AMOX-500', substanceCode: 'AMOXICILLIN', prescribedBy: 'dr1', dose: '500mg' });
  assert.equal(rx.ok, true);
  if (!rx.ok) return;
  let wl = await dispensingWorklist(db);
  assert.equal(wl.length, 1);
  assert.equal(wl[0]!.requestId, rx.requestId);
  await markDispensed(db, { requestId: rx.requestId, dispensedBy: 'pharm1' });
  wl = await dispensingWorklist(db);
  assert.equal(wl.length, 0); // dispensed → leaves the worklist
  await assert.rejects(() => markDispensed(db, { requestId: rx.requestId }), MedicationError); // already dispensed
});

test('a prescription prints from the signed requests', async () => {
  await db.prepare(`INSERT INTO organisation_staff (id, full_name, registration_no) VALUES ('dr1','Dr Osei','MD-1234')`).run();
  await prescribe(db, { patientId: PID, medicineCode: 'AMOX-500', substanceCode: 'AMOXICILLIN', prescribedBy: 'dr1', dose: '500mg', frequency: 'TDS', durationDays: 5, instructions: 'after food' });
  const doc = await generatePrescription(db, { patientId: PID, prescriberId: 'dr1', date: '2026-07-22' });
  assert.ok(doc.sections.length > 0);
  // Prescriber registration and patient instruction appear in the document.
  const text = JSON.stringify(doc);
  assert.match(text, /MD-1234/);
  assert.match(text, /after food/);
  await assert.rejects(() => generatePrescription(db, { patientId: PID, prescriberId: 'nobody' }), MedicationError);
});
