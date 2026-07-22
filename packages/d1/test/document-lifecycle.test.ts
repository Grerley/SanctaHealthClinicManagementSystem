/**
 * Document snapshot / versioning / retention on D1 (DOC-002/003/005). Runs on real
 * SQLite (same engine as D1). Proves: a generated document snapshots with a content
 * hash, supersede versions it, disposal is refused on legal hold or within
 * retention and allowed once past it (snapshot cleared, metadata kept).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storeGeneratedDocument, supersedeDocument, markDocumentEnteredInError, setLegalHold, setRetention, disposalCandidates, disposeDocument, DocLifecycleError } from '../src/document-lifecycle.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const doc = { type: 'referral-letter', title: 'Referral', sections: [{ heading: 'Body', lines: ['refer to cardiology'] }] } as any;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('a generated document snapshots with a content hash', async () => {
  const a = await storeGeneratedDocument(db, { document: doc, generatedBy: 'dr1', retentionClass: 'clinical-7y', retainUntil: '2033-01-01' });
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  const row = await db.prepare(`SELECT snapshot, status, size_bytes FROM clinical_document_reference WHERE id=?`).bind(a.documentId).first<{ snapshot: string; status: string; size_bytes: number }>();
  assert.equal(row?.status, 'available');
  assert.ok(Number(row?.size_bytes) > 0);
  assert.match(row!.snapshot, /cardiology/);
});

test('supersede versions the document', async () => {
  const a = await storeGeneratedDocument(db, { document: doc, generatedBy: 'dr1' });
  const b = await storeGeneratedDocument(db, { document: doc, generatedBy: 'dr1' });
  const s = await supersedeDocument(db, { documentId: a.documentId, newDocumentId: b.documentId, by: 'dr1' });
  assert.equal(s.version, 2);
  const oldStatus = await db.prepare(`SELECT status FROM clinical_document_reference WHERE id=?`).bind(a.documentId).first<{ status: string }>();
  assert.equal(oldStatus?.status, 'superseded');
  await assert.rejects(() => supersedeDocument(db, { documentId: a.documentId, newDocumentId: b.documentId, by: 'dr1' }), DocLifecycleError);
});

test('disposal respects legal hold and retention, then succeeds', async () => {
  const a = await storeGeneratedDocument(db, { document: doc, generatedBy: 'dr1', retentionClass: 'admin-1y', retainUntil: '2026-01-01' });
  await setLegalHold(db, { documentId: a.documentId, hold: true, by: 'legal' });
  await assert.rejects(() => disposeDocument(db, { documentId: a.documentId, asOf: '2026-07-22', by: 'admin' }), DocLifecycleError); // held
  await setLegalHold(db, { documentId: a.documentId, hold: false, by: 'legal' });
  // Now past retention (2026-01-01) as-of 2026-07-22 → a disposal candidate → dispose clears the snapshot.
  const cands = await disposalCandidates(db, '2026-07-22');
  assert.ok(cands.some((c) => c.id === a.documentId));
  await disposeDocument(db, { documentId: a.documentId, asOf: '2026-07-22', by: 'admin' });
  const row = await db.prepare(`SELECT status, snapshot, sha256 FROM clinical_document_reference WHERE id=?`).bind(a.documentId).first<{ status: string; snapshot: string | null; sha256: string }>();
  assert.equal(row?.status, 'disposed');
  assert.equal(row?.snapshot, null);       // content cleared
  assert.match(row!.sha256, /^[0-9a-f]{64}$/); // hash retained for audit
});

test('retention can be set and entered-in-error is retained', async () => {
  const a = await storeGeneratedDocument(db, { document: doc, generatedBy: 'dr1' });
  await setRetention(db, { documentId: a.documentId, retentionClass: 'legal-10y', retainUntil: '2036-01-01', by: 'admin' });
  await markDocumentEnteredInError(db, { documentId: a.documentId, reason: 'wrong patient', by: 'dr1' });
  const row = await db.prepare(`SELECT status, retention_class FROM clinical_document_reference WHERE id=?`).bind(a.documentId).first<{ status: string; retention_class: string }>();
  assert.equal(row?.status, 'entered_in_error'); // retained
  assert.equal(row?.retention_class, 'legal-10y');
});
