/**
 * Patient identity depth on D1: related persons + access (PAT-005/009) and
 * reversible merge (PAT-008). Runs on real SQLite (same engine as D1). Proves:
 * related persons/guardians, sensitivity-gated access with audit, and a merge that
 * repoints records to the survivor, hides the merged patient from search, and
 * reverses exactly.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addRelatedPerson, listRelatedPersons, guardians, accessPatient, RelationError } from '../src/patient-relations.ts';
import { mergePatients, unmergePatients, MergeError } from '../src/merge.ts';
import { listPatients } from '../src/patients.ts';
import { startVisit } from '../src/visits.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const A = 'pid-a', B = 'pid-b';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(A, 'SCC-060001', 'Ada', 'Survivor').run();
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(B, 'SCC-060002', 'Ada', 'Duplicate').run();
});

test('related persons + guardians', async () => {
  await addRelatedPerson(db, { patientId: A, name: 'Mary', relationship: 'mother', isGuardian: true, phone: '123' });
  await addRelatedPerson(db, { patientId: A, name: 'Sam', relationship: 'sibling' });
  await assert.rejects(() => addRelatedPerson(db, { patientId: A, name: 'x', relationship: 'bogus' }), RelationError);
  assert.equal((await listRelatedPersons(db, A)).length, 2);
  const g = await guardians(db, A);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.name, 'Mary');
});

test('sensitivity gates access and audits when required', async () => {
  await db.prepare(`UPDATE identity_patient SET sensitivity='sensitive' WHERE id=?`).bind(A).run();
  // A sensitive record needs a stated purpose.
  await assert.rejects(() => accessPatient(db, { patientId: A, roles: ['clinical'], user: 'dr1' }), RelationError);
  const ok = await accessPatient(db, { patientId: A, roles: ['clinical'], user: 'dr1', purpose: 'treatment' });
  assert.equal(ok.allowed, true);
  const audit = await db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE resource_id=? AND action='view'`).bind(A).first<{ n: number }>();
  assert.equal(Number(audit?.n), 1);
});

test('merge repoints records, hides the duplicate, and reverses exactly', async () => {
  const v = await startVisit(db, { patientId: B, station: 'reception' });
  const m = await mergePatients(db, { survivorId: A, mergedId: B, mergedBy: 'support' });
  assert.ok(m.movedRecords >= 1); // the visit moved
  // The visit now belongs to the survivor; the duplicate is hidden from search.
  const visit = await db.prepare(`SELECT patient_id FROM flow_visit WHERE id=?`).bind(v.visitId).first<{ patient_id: string }>();
  assert.equal(visit?.patient_id, A);
  assert.equal((await listPatients(db, 'Duplicate')).length, 0); // merged → not searchable
  await assert.rejects(() => mergePatients(db, { survivorId: A, mergedId: B, mergedBy: 'support' }), MergeError); // already merged
  // Reverse exactly.
  const u = await unmergePatients(db, { mergeId: m.mergeId, user: 'support' });
  assert.equal(u.restored, m.movedRecords);
  const back = await db.prepare(`SELECT patient_id FROM flow_visit WHERE id=?`).bind(v.visitId).first<{ patient_id: string }>();
  assert.equal(back?.patient_id, B); // repointed back
  assert.equal((await listPatients(db, 'Duplicate')).length, 1); // visible again
});

test('cannot merge a patient into itself', async () => {
  await assert.rejects(() => mergePatients(db, { survivorId: A, mergedId: A, mergedBy: 'x' }), MergeError);
});
