/**
 * Prescribing with allergy checking + controlled override on D1 (MED-002/003/004/
 * 009, UAT-05). Runs on real SQLite (same engine as D1). Proves the safety
 * invariant: a substance-matched allergy blocks the prescription unless overridden
 * with a reason; templates only propose (never bypass the check); a not-given
 * administration requires a reason.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordAllergy, prescribe, defineRxTemplate, applyRxTemplate, recordAdministration, listAdministrations, PrescribingError } from '../src/prescribing.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'rx-pat-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-600001', 'Rx', 'Test').run();
});

test('a clear prescription is created', async () => {
  const r = await prescribe(db, { patientId: PID, medicineCode: 'AMOX-500', substanceCode: 'AMOXICILLIN', prescribedBy: 'dr1', dose: '500mg', frequency: 'TDS' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.overridden, false);
});

test('an allergy blocks the prescription until overridden with a reason', async () => {
  await recordAllergy(db, { patientId: PID, substanceCode: 'PENICILLIN', severity: 'critical' });
  const blocked = await prescribe(db, { patientId: PID, medicineCode: 'PEN-V', substanceCode: 'PENICILLIN', prescribedBy: 'dr1' });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.alerts[0]!.severity, 'critical');
  // Override without a reason is rejected.
  await assert.rejects(() => prescribe(db, { patientId: PID, medicineCode: 'PEN-V', substanceCode: 'PENICILLIN', prescribedBy: 'dr1', override: true }), PrescribingError);
  // Override with a reason succeeds and is recorded.
  const ov = await prescribe(db, { patientId: PID, medicineCode: 'PEN-V', substanceCode: 'PENICILLIN', prescribedBy: 'dr1', override: true, overrideReason: 'no alternative; monitored' });
  assert.equal(ov.ok, true);
  if (ov.ok) {
    assert.equal(ov.overridden, true);
    const row = await db.prepare(`SELECT override_reason, override_by FROM clinical_medication_request WHERE id=?`).bind(ov.requestId).first<{ override_reason: string; override_by: string }>();
    assert.equal(row?.override_reason, 'no alternative; monitored');
    assert.equal(row?.override_by, 'dr1');
  }
});

test('a template proposes lines only (does not create requests)', async () => {
  await defineRxTemplate(db, { code: 'URTI', name: 'Upper resp infection', items: [{ medicineCode: 'AMOX-500', substanceCode: 'AMOXICILLIN', dose: '500mg' }] });
  const { proposals } = await applyRxTemplate(db, { templateCode: 'URTI' });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.requiresConfirmation, true);
  const created = await db.prepare(`SELECT COUNT(*) AS n FROM clinical_medication_request`).first<{ n: number }>();
  assert.equal(Number(created?.n), 0); // nothing prescribed by applying a template
});

test('administrations are recorded; not-given requires a reason', async () => {
  const r = await prescribe(db, { patientId: PID, medicineCode: 'PARA', substanceCode: 'PARACETAMOL', prescribedBy: 'dr1' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  await recordAdministration(db, { requestId: r.requestId, performer: 'nurse1', dose: '1g', status: 'given' });
  await assert.rejects(() => recordAdministration(db, { requestId: r.requestId, performer: 'nurse1', status: 'not_given' }), PrescribingError);
  await recordAdministration(db, { requestId: r.requestId, performer: 'nurse1', status: 'not_given', reason: 'patient refused' });
  const hist = await listAdministrations(db, { requestId: r.requestId });
  assert.equal(hist.length, 2);
});
