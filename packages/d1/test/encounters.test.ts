/**
 * Clinical encounter lifecycle on D1 (EHR-008/009, BR-003, UAT-04). Runs on real
 * SQLite (same engine as D1). Proves the core immutability guarantee: a signed
 * encounter cannot be edited, only addended or marked entered-in-error, and the
 * original content is retained throughout.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftEncounter, updateDraft, signEncounter, addAddendum, markEnteredInError, getEncounter, EncounterError } from '../src/encounters.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'enc-pat-1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'SCC-800001', 'Enc', 'Test').run();
});

test('draft can be edited, signing makes it immutable', async () => {
  const { encounterId } = await createDraftEncounter(db, { patientId: PID });
  await updateDraft(db, { encounterId, content: { note: 'v1' } });
  const signed = await signEncounter(db, { encounterId, signedBy: 'dr1', content: { note: 'final' } });
  assert.equal(signed.status, 'signed');
  // Editing a signed encounter is rejected.
  await assert.rejects(() => updateDraft(db, { encounterId, content: { note: 'tamper' } }), EncounterError);
  const got = await getEncounter(db, encounterId);
  assert.equal(got.status, 'signed');
  assert.deepEqual(got.content, { note: 'final' });
  assert.equal(got.signedBy, 'dr1');
});

test('a signed encounter takes addenda; the original is untouched', async () => {
  const { encounterId } = await createDraftEncounter(db, { patientId: PID });
  await signEncounter(db, { encounterId, signedBy: 'dr1', content: { bp: '120/80' } });
  const { addendumId } = await addAddendum(db, { encounterId, author: 'dr2', content: { note: 'follow-up' } });
  assert.ok(addendumId);
  const got = await getEncounter(db, encounterId);
  assert.deepEqual(got.content, { bp: '120/80' });     // original retained
  assert.equal(got.addenda.length, 1);
  assert.deepEqual(got.addenda[0]!.content, { note: 'follow-up' });
});

test('addenda are rejected on an unsigned encounter', async () => {
  const { encounterId } = await createDraftEncounter(db, { patientId: PID });
  await assert.rejects(() => addAddendum(db, { encounterId, author: 'dr2', content: {} }), EncounterError);
});

test('entered-in-error is allowed only from signed, and re-signing is blocked', async () => {
  const { encounterId } = await createDraftEncounter(db, { patientId: PID });
  await signEncounter(db, { encounterId, signedBy: 'dr1', content: {} });
  await markEnteredInError(db, { encounterId, user: 'dr1', reason: 'wrong patient' });
  const got = await getEncounter(db, encounterId);
  assert.equal(got.status, 'entered_in_error');
  // Cannot sign again after entered-in-error.
  await assert.rejects(() => signEncounter(db, { encounterId, signedBy: 'dr1' }), Error);
});
