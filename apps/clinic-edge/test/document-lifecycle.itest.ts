/**
 * Document generation snapshot, versioning & retention (DOC-002/003/005) against
 * real PostgreSQL. Proves: a generated document retains an immutable snapshot +
 * hash; documents supersede/version and can be entered-in-error; and disposal is
 * driven by retention and refused while on legal hold or within retention.
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
import { visitSummary } from '@sancta/domain';
import { storeGeneratedDocument, supersedeDocument, markDocumentEnteredInError, setLegalHold, setRetention, disposalCandidates, disposeDocument, DocLifecycleError } from '../src/document-lifecycle.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const CLERK = '00000000-0000-7000-8000-0000000000c1';

function sampleDoc() {
  return visitSummary({ patient: { id: PATIENT, mrn: 'SCC-000101', name: 'Alpha, Testpatient' }, date: '2026-07-20', clinician: 'Dr B', reason: 'cough', plan: 'rest' });
}

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

test('a generated document retains an immutable snapshot + hash (DOC-002)', { skip }, async () => {
  const res = await storeGeneratedDocument(pool, { patientId: PATIENT, document: sampleDoc(), generatedBy: CLERK });
  assert.ok(res.documentId);
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  const row = await pool.query(`SELECT snapshot, sha256, status FROM clinical.document_reference WHERE id=$1`, [res.documentId]);
  assert.equal(row.rows[0].status, 'available');
  assert.equal(row.rows[0].snapshot.type, 'visit_summary'); // snapshot retained
  assert.equal(row.rows[0].sha256, res.sha256);
});

test('documents supersede/version and can be entered-in-error (DOC-003)', { skip }, async () => {
  const v1 = await storeGeneratedDocument(pool, { patientId: PATIENT, document: sampleDoc(), generatedBy: CLERK });
  const v2 = await storeGeneratedDocument(pool, { patientId: PATIENT, document: sampleDoc(), generatedBy: CLERK });
  const sup = await supersedeDocument(pool, { documentId: v1.documentId, newDocumentId: v2.documentId, by: CLERK });
  assert.equal(sup.version, 2);
  const st = await pool.query(`SELECT status FROM clinical.document_reference WHERE id=$1`, [v1.documentId]);
  assert.equal(st.rows[0].status, 'superseded');
  await assert.rejects(supersedeDocument(pool, { documentId: v1.documentId, newDocumentId: v2.documentId, by: CLERK }), /superseded document cannot/);

  await markDocumentEnteredInError(pool, { documentId: v2.documentId, reason: 'wrong patient', by: CLERK });
  const eie = await pool.query(`SELECT status FROM clinical.document_reference WHERE id=$1`, [v2.documentId]);
  assert.equal(eie.rows[0].status, 'entered_in_error');
});

test('disposal follows retention and legal hold (DOC-005)', { skip }, async () => {
  const doc = await storeGeneratedDocument(pool, { patientId: PATIENT, document: sampleDoc(), generatedBy: CLERK });
  await setRetention(pool, { documentId: doc.documentId, retentionClass: 'clinical-7y', retainUntil: '2026-06-01', by: CLERK });

  // Eligible after its retain-until date...
  assert.ok((await disposalCandidates(pool, '2026-07-20')).some((c) => c.id === doc.documentId));
  // ...but a legal hold blocks disposal.
  await setLegalHold(pool, { documentId: doc.documentId, hold: true, by: CLERK });
  assert.ok(!(await disposalCandidates(pool, '2026-07-20')).some((c) => c.id === doc.documentId));
  await assert.rejects(disposeDocument(pool, { documentId: doc.documentId, asOf: '2026-07-20', by: CLERK }), /legal hold/);

  // Lift the hold → disposable; within retention is refused.
  await setLegalHold(pool, { documentId: doc.documentId, hold: false, by: CLERK });
  await assert.rejects(disposeDocument(pool, { documentId: doc.documentId, asOf: '2026-05-01', by: CLERK }), /within its retention/);
  const res = await disposeDocument(pool, { documentId: doc.documentId, asOf: '2026-07-20', by: CLERK });
  assert.equal(res.status, 'disposed');
  const row = await pool.query(`SELECT status, snapshot FROM clinical.document_reference WHERE id=$1`, [doc.documentId]);
  assert.equal(row.rows[0].status, 'disposed');
  assert.equal(row.rows[0].snapshot, null); // content cleared, metadata + hash retained
  await assert.rejects(disposeDocument(pool, { documentId: doc.documentId, asOf: '2026-07-20', by: CLERK }), /already disposed/);
});
