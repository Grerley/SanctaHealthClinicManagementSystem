/**
 * Document upload + disclosure tracking (DOC-001/004/007) against real PostgreSQL.
 * Proves: a valid document is stored available; a disallowed type is quarantined
 * and cannot be opened; opening a sensitive document records a disclosure.
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
import { uploadDocument, openDocument, disclosureLog, DocumentError } from '../src/documents.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const USER = '00000000-0000-7000-8000-0000000000e1';
const HASH = 'b'.repeat(64);

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

test('a valid PDF is stored available and can be opened', { skip }, async () => {
  const up = await uploadDocument(pool, { patientId: PATIENT, docType: 'referral', filename: 'referral.pdf', mimeType: 'application/pdf', sizeBytes: 2048, sha256: HASH, uploadedBy: USER });
  assert.equal(up.status, 'available');
  const opened = await openDocument(pool, { documentId: up.documentId, userId: USER });
  assert.equal(opened.mimeType, 'application/pdf');
});

test('a disallowed type is quarantined and cannot be opened (DOC-004)', { skip }, async () => {
  const up = await uploadDocument(pool, { patientId: PATIENT, docType: 'unknown', filename: 'macro.docm', mimeType: 'application/vnd.ms-word.document.macroEnabled.12', sizeBytes: 2048, sha256: HASH, uploadedBy: USER });
  assert.equal(up.status, 'quarantined');
  assert.equal(up.reason, 'type_not_allowed');
  await assert.rejects(openDocument(pool, { documentId: up.documentId, userId: USER }), DocumentError);
});

test('opening a sensitive document records a disclosure (DOC-007)', { skip }, async () => {
  const up = await uploadDocument(pool, { patientId: PATIENT, docType: 'hiv-result', filename: 'result.pdf', mimeType: 'application/pdf', sizeBytes: 1024, sha256: HASH, securityLabel: 'sensitive', uploadedBy: USER });
  await openDocument(pool, { documentId: up.documentId, userId: USER, purpose: 'treatment' });
  const log = await disclosureLog(pool, up.documentId);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.userId, USER);
  assert.equal(log[0]!.purpose, 'treatment');
});

test('opening a normal document does not create a disclosure', { skip }, async () => {
  const up = await uploadDocument(pool, { patientId: PATIENT, docType: 'consent', filename: 'consent.png', mimeType: 'image/png', sizeBytes: 500, sha256: HASH, uploadedBy: USER });
  await openDocument(pool, { documentId: up.documentId, userId: USER });
  assert.equal((await disclosureLog(pool, up.documentId)).length, 0);
});
