/**
 * Clinical history, coded diagnoses & draft recovery (EHR-004/005/007) against
 * real PostgreSQL. Proves: structured history is captured and status-tracked;
 * diagnoses are coded (resolved from an offline-searchable table) or free-text
 * with certainty + rank; and an interrupted draft recovers to the SAME encounter
 * rather than creating a duplicate.
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
import { addHistoryItem, setHistoryStatus, listHistory, searchDiagnosisCodes, recordDiagnosis, listDiagnoses, openDraftEncounter, autosaveDraft, EhrError } from '../src/ehr.ts';
import { signEncounter } from '../src/encounters.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000102';
const DOCTOR = '00000000-0000-7000-8000-0000000000e1';

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

test('structured history is captured and status-tracked (EHR-004)', { skip }, async () => {
  const p = await addHistoryItem(pool, { patientId: PATIENT, category: 'problem', detail: 'Hypertension', onsetDate: '2020-01-01', user: DOCTOR });
  await addHistoryItem(pool, { patientId: PATIENT, category: 'allergy', detail: 'Penicillin', user: DOCTOR });
  await addHistoryItem(pool, { patientId: PATIENT, category: 'immunisation', detail: 'Tetanus 2025', user: DOCTOR });
  await assert.rejects(addHistoryItem(pool, { patientId: PATIENT, category: 'nonsense', detail: 'x' }), EhrError);

  const all = await listHistory(pool, PATIENT);
  assert.ok(all.length >= 3);
  assert.ok((await listHistory(pool, PATIENT, 'allergy')).some((h) => h.detail === 'Penicillin'));

  await setHistoryStatus(pool, { id: p.id, status: 'resolved' });
  assert.equal((await listHistory(pool, PATIENT, 'problem')).find((h) => h.id === p.id)!.status, 'resolved');
});

test('diagnoses are coded from an offline-searchable table, or free text (EHR-005)', { skip }, async () => {
  const codes = await searchDiagnosisCodes(pool, 'hyperten');
  assert.ok(codes.some((c) => c.code === 'I10'));

  const draft = await openDraftEncounter(pool, { patientId: PATIENT });
  const dx = await recordDiagnosis(pool, { encounterId: draft.encounterId, code: 'I10', certainty: 'confirmed', rank: 1, user: DOCTOR });
  assert.equal(dx.display, 'Essential (primary) hypertension'); // resolved from the code table
  await recordDiagnosis(pool, { encounterId: draft.encounterId, freeText: 'query viral syndrome', certainty: 'suspected', rank: 2, user: DOCTOR });

  await assert.rejects(recordDiagnosis(pool, { encounterId: draft.encounterId, code: 'ZZZ' }), /unknown diagnosis code/);
  await assert.rejects(recordDiagnosis(pool, { encounterId: draft.encounterId, certainty: 'maybe', freeText: 'x' }), EhrError);
  await assert.rejects(recordDiagnosis(pool, { encounterId: draft.encounterId, user: DOCTOR }), /code or free text/);

  const list = await listDiagnoses(pool, draft.encounterId);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.rank, 1); // primary first
  assert.equal(list[0]!.code, 'I10');
});

test('an interrupted draft recovers to the SAME encounter, no duplicate (EHR-007)', { skip }, async () => {
  const NEWP = '00000000-0000-7000-8000-000000000101';
  const first = await openDraftEncounter(pool, { patientId: NEWP });
  assert.equal(first.recovered, false);
  await autosaveDraft(pool, { encounterId: first.encounterId, content: { history: 'partial note' } });

  // Simulate a reconnect: opening a draft again returns the SAME encounter + content.
  const again = await openDraftEncounter(pool, { patientId: NEWP });
  assert.equal(again.recovered, true);
  assert.equal(again.encounterId, first.encounterId);
  assert.equal((again.content as { history: string }).history, 'partial note');

  // Exactly one draft encounter exists for the patient.
  const count = await pool.query(`SELECT count(*)::int AS n FROM clinical.encounter WHERE patient_id=$1 AND status='draft'`, [NEWP]);
  assert.equal(count.rows[0].n, 1);

  // After signing, autosave is refused (immutable) and a new draft opens instead of recovering.
  await signEncounter(pool, { encounterId: first.encounterId, signedBy: DOCTOR, content: { history: 'final' } });
  await assert.rejects(autosaveDraft(pool, { encounterId: first.encounterId, content: { x: 1 } }), /already signed|no open draft/);
  const fresh = await openDraftEncounter(pool, { patientId: NEWP });
  assert.notEqual(fresh.encounterId, first.encounterId);
});
