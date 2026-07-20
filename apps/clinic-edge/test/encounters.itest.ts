/**
 * Encounter signing + addendum + entered-in-error (EHR-008/009, BR-003, UAT-04)
 * against real PostgreSQL. Proves: a draft can be edited then signed; a signed
 * encounter is immutable (draft edits rejected, re-sign rejected); corrections go
 * through a linked addendum while the original content remains visible; and
 * entered-in-error preserves the original.
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
import { TransitionError } from '@sancta/domain';
import { createDraftEncounter, updateDraft, signEncounter, addAddendum, markEnteredInError, getEncounter, EncounterError } from '../src/encounters.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
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

test('a draft can be edited then signed; signing makes it immutable (BR-003)', { skip }, async () => {
  const { encounterId } = await createDraftEncounter(pool, { patientId: PATIENT });
  await updateDraft(pool, { encounterId, content: { assessment: 'URTI', plan: 'rest, fluids' } });
  await signEncounter(pool, { encounterId, signedBy: DOCTOR });

  const enc = await getEncounter(pool, encounterId);
  assert.equal(enc.status, 'signed');
  assert.equal(enc.signedBy, DOCTOR);
  assert.equal((enc.content as { assessment: string }).assessment, 'URTI');

  // Editing signed content is rejected.
  await assert.rejects(updateDraft(pool, { encounterId, content: { assessment: 'changed' } }), EncounterError);
  // Re-signing is an illegal transition.
  await assert.rejects(signEncounter(pool, { encounterId, signedBy: DOCTOR }), TransitionError);
});

test('a correction is an addendum; the original stays visible (EHR-009, UAT-04)', { skip }, async () => {
  const { encounterId } = await createDraftEncounter(pool, { patientId: PATIENT });
  await signEncounter(pool, { encounterId, signedBy: DOCTOR, content: { assessment: 'tonsillitis' } });
  await addAddendum(pool, { encounterId, author: DOCTOR, content: { note: 'culture later confirmed strep' } });

  const enc = await getEncounter(pool, encounterId);
  assert.equal((enc.content as { assessment: string }).assessment, 'tonsillitis'); // original preserved
  assert.equal(enc.addenda.length, 1);
  assert.match((enc.addenda[0]!.content as { note: string }).note, /strep/);
});

test('an addendum cannot be added to a draft (only to signed)', { skip }, async () => {
  const { encounterId } = await createDraftEncounter(pool, { patientId: PATIENT });
  await assert.rejects(addAddendum(pool, { encounterId, author: DOCTOR, content: {} }), EncounterError);
});

test('entered-in-error preserves the original content', { skip }, async () => {
  const { encounterId } = await createDraftEncounter(pool, { patientId: PATIENT });
  await signEncounter(pool, { encounterId, signedBy: DOCTOR, content: { assessment: 'wrong patient chart' } });
  await markEnteredInError(pool, { encounterId, user: DOCTOR, reason: 'documented on wrong patient' });
  const enc = await getEncounter(pool, encounterId);
  assert.equal(enc.status, 'entered_in_error');
  assert.equal((enc.content as { assessment: string }).assessment, 'wrong patient chart'); // still visible
});
