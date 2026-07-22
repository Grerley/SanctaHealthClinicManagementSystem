/**
 * Documents on D1 (DOC-001/004/006/007). Runs on real SQLite (same engine as D1).
 * Proves: a policy-failing upload is quarantined and cannot open, a sensitive open
 * records a disclosure, and additive re-indexing makes a document findable by term.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { uploadDocument, openDocument, disclosureLog, indexDocument, searchDocuments, DocumentError } from '../src/documents.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const good = { filename: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: 1000, sha256: 'a'.repeat(64) };

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('a valid upload is available; a policy-failing upload is quarantined and cannot open', async () => {
  const ok = await uploadDocument(db, { ...good, docType: 'referral' });
  assert.equal(ok.status, 'available');
  // An executable mime type fails the policy → quarantined.
  const bad = await uploadDocument(db, { filename: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 10, sha256: 'b'.repeat(64), docType: 'other' });
  assert.equal(bad.status, 'quarantined');
  await assert.rejects(() => openDocument(db, { documentId: bad.documentId, userId: 'u1' }), DocumentError);
});

test('opening a sensitive document records a disclosure', async () => {
  const up = await uploadDocument(db, { ...good, docType: 'psych', securityLabel: 'sensitive' });
  const opened = await openDocument(db, { documentId: up.documentId, userId: 'dr1', purpose: 'treatment' });
  assert.equal(opened.securityLabel, 'sensitive');
  const log = await disclosureLog(db, up.documentId);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.userId, 'dr1');
  assert.equal(log[0]!.purpose, 'treatment');
});

test('re-indexing is additive and makes a document searchable by term', async () => {
  const up = await uploadDocument(db, { ...good, docType: 'lab' });
  const v1 = await indexDocument(db, { documentId: up.documentId, terms: ['malaria'] });
  assert.equal(v1.version, 1);
  const v2 = await indexDocument(db, { documentId: up.documentId, terms: ['malaria', 'positive'] });
  assert.equal(v2.version, 2); // additive — new version
  const hits = await searchDocuments(db, 'positive');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.documentId, up.documentId);
  assert.equal(hits[0]!.version, 2); // latest index
});
