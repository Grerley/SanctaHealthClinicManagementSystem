/**
 * Billing document print/reprint & document index/OCR (BIL-007, DOC-006) against
 * real PostgreSQL. Proves: a first print is the original and a reprint is marked
 * COPY; and re-indexing a document appends a new version without overwriting the
 * source file or its hash.
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
import { doCheckout } from '../src/api.ts';
import { uploadDocument, indexDocument, searchDocuments } from '../src/documents.ts';
import { printReceipt, printInvoice, printStatement, BillingPrintError } from '../src/billing-print.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
let PAYMENT: string;
let INVOICE: string;
const HASH = 'a'.repeat(64);

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
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 1500, paymentMinor: 1500, paymentMethod: 'cash' });
  const pay = await pool.query(`SELECT id FROM billing.payment WHERE patient_id=$1 LIMIT 1`, [PATIENT]);
  PAYMENT = pay.rows[0].id;
  const inv = await pool.query(`SELECT id FROM billing.invoice WHERE patient_id=$1 LIMIT 1`, [PATIENT]);
  INVOICE = inv.rows[0].id;
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('a receipt reprint is marked COPY; the original is not (BIL-007)', { skip }, async () => {
  const original = await printReceipt(pool, { paymentId: PAYMENT, printedBy: PATIENT });
  assert.equal(original.copyNumber, 1);
  assert.equal(original.copyMarker, null);
  assert.equal(original.totalMinor, 1500);

  const reprint = await printReceipt(pool, { paymentId: PAYMENT, printedBy: PATIENT });
  assert.equal(reprint.copyNumber, 2);
  assert.equal(reprint.copyMarker, 'COPY (reprint #1)');

  // Every issue is recorded and audited.
  const prints = await pool.query(`SELECT count(*)::int AS n FROM billing.document_print WHERE kind='receipt' AND ref_id=$1`, [PAYMENT]);
  assert.equal(prints.rows[0].n, 2);
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='receipt_print'`);
  assert.ok((audit.rows[0].n as number) >= 2);
});

test('invoice and statement print with copy tracking (BIL-007)', { skip }, async () => {
  const inv = await printInvoice(pool, { invoiceId: INVOICE, printedBy: PATIENT });
  assert.equal(inv.kind, 'invoice');
  assert.ok(inv.totalMinor > 0);
  assert.equal(inv.copyMarker, null);

  const stmt = await printStatement(pool, { patientId: PATIENT, printedBy: PATIENT });
  assert.equal(stmt.kind, 'statement');
  const stmt2 = await printStatement(pool, { patientId: PATIENT, printedBy: PATIENT });
  assert.equal(stmt2.copyMarker, 'COPY (reprint #1)');

  await assert.rejects(printReceipt(pool, { paymentId: '00000000-0000-7000-8000-0000000000ff' }), BillingPrintError);
});

test('re-indexing appends a version and never overwrites the source (DOC-006)', { skip }, async () => {
  const up = await uploadDocument(pool, { patientId: PATIENT, docType: 'scan', filename: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: 1024, sha256: HASH });
  assert.equal(up.status, 'available');

  const v1 = await indexDocument(pool, { documentId: up.documentId, terms: ['discharge', 'summary'], ocrText: 'discharge summary text' });
  assert.equal(v1.version, 1);
  const v2 = await indexDocument(pool, { documentId: up.documentId, terms: ['discharge', 'corrected'], ocrText: 'corrected text' });
  assert.equal(v2.version, 2);

  // Both index versions are retained (additive, not overwrite).
  const versions = await pool.query(`SELECT count(*)::int AS n FROM clinical.document_index WHERE document_id=$1`, [up.documentId]);
  assert.equal(versions.rows[0].n, 2);

  // The source file + hash are untouched.
  const src = await pool.query(`SELECT sha256, filename FROM clinical.document_reference WHERE id=$1`, [up.documentId]);
  assert.equal(src.rows[0].sha256, HASH);
  assert.equal(src.rows[0].filename, 'scan.pdf');

  // Search finds it by a current term.
  const found = await searchDocuments(pool, 'corrected');
  assert.ok(found.some((d) => d.documentId === up.documentId && d.version === 2));
});
