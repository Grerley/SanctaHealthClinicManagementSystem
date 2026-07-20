import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitSummary, prescriptionDoc, sickNote, referralLetter, DocGenError } from './docgen.ts';

const patient = { id: 'p1', mrn: 'SCC-000101', name: 'Alpha, Testpatient' };

test('visit summary assembles patient/diagnoses/plan with DD/MM/YYYY (EHR-011)', () => {
  const doc = visitSummary({ patient, date: '2026-07-20', clinician: 'Dr B', reason: 'cough', diagnoses: [{ display: 'Pneumonia', certainty: 'confirmed' }], plan: 'Antibiotics' });
  assert.equal(doc.type, 'visit_summary');
  assert.equal(doc.patientRef, 'p1');
  assert.ok(doc.sections.some((s) => s.lines.some((l) => l.includes('20/07/2026'))));
  assert.ok(doc.sections.some((s) => s.heading === 'Diagnoses' && s.lines[0]!.includes('Pneumonia')));
});

test('prescription requires at least one item (EHR-011)', () => {
  assert.throws(() => prescriptionDoc({ patient, date: '2026-07-20', prescriber: 'Dr B', items: [] }), DocGenError);
  const doc = prescriptionDoc({ patient, date: '2026-07-20', prescriber: 'Dr B', items: [{ drug: 'Amoxicillin', dose: '500mg', frequency: 'TDS', duration: '5 days' }] });
  assert.equal(doc.type, 'prescription');
  assert.ok(doc.sections.some((s) => s.lines.some((l) => l.includes('Amoxicillin'))));
});

test('sick note validates the date range (EHR-011)', () => {
  assert.throws(() => sickNote({ patient, from: '2026-07-20', to: '2026-07-18', reason: 'flu', clinician: 'Dr B' }), DocGenError);
  const doc = sickNote({ patient, from: '2026-07-20', to: '2026-07-23', reason: 'flu', clinician: 'Dr B' });
  assert.equal(doc.type, 'sick_note');
  assert.ok(doc.sections.some((s) => s.lines.some((l) => l.includes('20/07/2026') && l.includes('23/07/2026'))));
});

test('referral letter needs a destination (EHR-011)', () => {
  assert.throws(() => referralLetter({ patient, date: '2026-07-20', referrer: 'Dr B', referTo: '', reason: 'x' }), DocGenError);
  const doc = referralLetter({ patient, date: '2026-07-20', referrer: 'Dr B', referTo: 'District Hospital', reason: 'Further imaging', findings: 'Suspicious mass' });
  assert.equal(doc.type, 'referral_letter');
  assert.equal(doc.sections[0]!.heading, 'To');
  assert.ok(doc.sections.some((s) => s.heading === 'Relevant findings'));
});
