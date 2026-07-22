/**
 * Clinical history, coded diagnoses & draft recovery on D1 (EHR-004/005/007).
 * Runs on real SQLite. Proves: history items are category-validated and status-
 * tracked; diagnosis-code search is offline; a diagnosis needs a valid code or
 * free text; and an interrupted draft encounter is recovered (not duplicated).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addHistoryItem, setHistoryStatus, listHistory, searchDiagnosisCodes, recordDiagnosis, listDiagnoses, openDraftEncounter, autosaveDraft, EhrError } from '../src/ehr.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'ehr-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn) VALUES (?,?)`).bind(PID, 'MRN-EHR1').run();
});

test('history items are category-validated and status-tracked', async () => {
  await assert.rejects(() => addHistoryItem(db, { patientId: PID, category: 'nonsense', detail: 'x' }), EhrError);
  const { id } = await addHistoryItem(db, { patientId: PID, category: 'problem', detail: 'Hypertension', code: 'I10' });
  assert.equal((await listHistory(db, PID, 'problem')).length, 1);
  await setHistoryStatus(db, { id, status: 'resolved' });
  assert.equal((await listHistory(db, PID))[0]?.status, 'resolved');
  await assert.rejects(() => setHistoryStatus(db, { id, status: 'bogus' }), EhrError);
});

test('diagnosis-code search is offline and record needs a valid code or free text', async () => {
  const hits = await searchDiagnosisCodes(db, 'diabetes');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.code, 'E11');
  const enc = await openDraftEncounter(db, { patientId: PID });
  await assert.rejects(() => recordDiagnosis(db, { encounterId: enc.encounterId }), EhrError); // neither code nor free text
  await assert.rejects(() => recordDiagnosis(db, { encounterId: enc.encounterId, code: 'ZZ9' }), EhrError); // unknown code
  const dx = await recordDiagnosis(db, { encounterId: enc.encounterId, code: 'E11', rank: 1 });
  assert.equal(dx.display, 'Type 2 diabetes mellitus (synthetic)');
  const free = await recordDiagnosis(db, { encounterId: enc.encounterId, freeText: 'clinical impression', rank: 2 });
  assert.equal(free.display, 'clinical impression');
  assert.equal((await listDiagnoses(db, enc.encounterId)).length, 2);
});

test('an interrupted draft encounter is recovered, not duplicated', async () => {
  const first = await openDraftEncounter(db, { patientId: PID });
  assert.equal(first.recovered, false);
  await autosaveDraft(db, { encounterId: first.encounterId, content: { note: 'in progress' } });
  const second = await openDraftEncounter(db, { patientId: PID });
  assert.equal(second.recovered, true);
  assert.equal(second.encounterId, first.encounterId); // same encounter
  assert.deepEqual(second.content, { note: 'in progress' });
  // Once signed, autosave is refused.
  await db.prepare(`UPDATE clinical_encounter SET status='signed' WHERE id=?`).bind(first.encounterId).run();
  await assert.rejects(() => autosaveDraft(db, { encounterId: first.encounterId, content: {} }), EhrError);
});
